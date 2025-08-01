const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { body, validationResult } = require('express-validator');
const router = express.Router();

// Services
const blockchainService = require('../services/blockchainService');
const ipfsService = require('../services/ipfsService');
const aiService = require('../services/aiService');

// Models
const { Document, Citizen } = require('../models');

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and PDF files are allowed.'));
    }
  },
});

// Validation middleware
const validateDocument = [
  body('documentType')
    .isIn(['aadhar', 'pan', 'voter_id', 'driving_license', 'passport', 'birth_certificate', 'other'])
    .withMessage('Invalid document type'),
  body('expiryDate')
    .optional()
    .isISO8601()
    .withMessage('Invalid expiry date format'),
];

// Get all documents for a citizen
router.get('/', async (req, res) => {
  try {
    const citizenAddress = req.user.address;
    
    // Get documents from blockchain
    const documentIds = await blockchainService.getCitizenDocuments(citizenAddress);
    
    const documents = await Promise.all(
      documentIds.map(async (id) => {
        const blockchainDoc = await blockchainService.getDocument(id);
        const dbDoc = await Document.findOne({ where: { blockchainId: id } });
        
        return {
          id,
          ...blockchainDoc,
          metadata: dbDoc ? dbDoc.metadata : null,
          aiAnalysis: dbDoc ? dbDoc.aiAnalysis : null,
        };
      })
    );
    
    res.json({
      success: true,
      data: documents,
    });
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch documents',
      error: error.message,
    });
  }
});

// Upload a new document
router.post('/upload', upload.single('document'), validateDocument, async (req, res) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array(),
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded',
      });
    }
    
    const { documentType, expiryDate } = req.body;
    const citizenAddress = req.user.address;
    
    // Process image if needed
    let processedFile = req.file.buffer;
    if (req.file.mimetype.startsWith('image/')) {
      processedFile = await sharp(req.file.buffer)
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    }
    
    // Upload to IPFS
    const ipfsHash = await ipfsService.uploadFile(processedFile);
    
    // AI Analysis
    const aiAnalysis = await aiService.analyzeDocument(processedFile, documentType);
    
    // Create metadata hash
    const metadata = {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadDate: new Date().toISOString(),
      documentType,
      aiAnalysis,
    };
    const metadataHash = await ipfsService.uploadJSON(metadata);
    
    // Upload to blockchain
    const expiryTimestamp = expiryDate ? Math.floor(new Date(expiryDate).getTime() / 1000) : 0;
    const documentId = await blockchainService.uploadDocument(
      citizenAddress,
      documentType,
      ipfsHash,
      metadataHash,
      expiryTimestamp
    );
    
    // Store in database
    const dbDocument = await Document.create({
      blockchainId: documentId,
      citizenAddress,
      documentType,
      ipfsHash,
      metadataHash,
      metadata,
      aiAnalysis,
      status: 'pending',
    });
    
    // Emit real-time update
    const io = req.app.get('io');
    io.to(`citizen-${citizenAddress}`).emit('document-uploaded', {
      documentId,
      documentType,
      status: 'pending',
    });
    
    res.status(201).json({
      success: true,
      message: 'Document uploaded successfully',
      data: {
        documentId,
        ipfsHash,
        aiAnalysis: aiAnalysis.summary,
      },
    });
  } catch (error) {
    console.error('Error uploading document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload document',
      error: error.message,
    });
  }
});

// Get document details
router.get('/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const citizenAddress = req.user.address;
    
    // Get document from blockchain
    const blockchainDoc = await blockchainService.getDocument(documentId);
    
    // Verify ownership
    if (blockchainDoc.owner.toLowerCase() !== citizenAddress.toLowerCase()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You are not the owner of this document.',
      });
    }
    
    // Get additional data from database
    const dbDoc = await Document.findOne({ where: { blockchainId: documentId } });
    
    // Get file from IPFS
    const fileBuffer = await ipfsService.getFile(blockchainDoc.ipfsHash);
    const metadata = await ipfsService.getJSON(blockchainDoc.metadataHash);
    
    res.json({
      success: true,
      data: {
        ...blockchainDoc,
        metadata,
        aiAnalysis: dbDoc ? dbDoc.aiAnalysis : null,
        fileData: fileBuffer.toString('base64'),
      },
    });
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch document',
      error: error.message,
    });
  }
});

// Verify document (for authorized issuers)
router.post('/:documentId/verify', async (req, res) => {
  try {
    const { documentId } = req.params;
    const issuerAddress = req.user.address;
    
    // Check if user is authorized issuer
    const isAuthorized = await blockchainService.isAuthorizedIssuer(issuerAddress);
    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You are not an authorized issuer.',
      });
    }
    
    // Verify document on blockchain
    await blockchainService.verifyDocument(documentId, issuerAddress);
    
    // Update database
    await Document.update(
      { status: 'verified', verifiedBy: issuerAddress, verifiedAt: new Date() },
      { where: { blockchainId: documentId } }
    );
    
    // Get document owner for notification
    const blockchainDoc = await blockchainService.getDocument(documentId);
    
    // Emit real-time update
    const io = req.app.get('io');
    io.to(`citizen-${blockchainDoc.owner}`).emit('document-verified', {
      documentId,
      verifiedBy: issuerAddress,
    });
    
    res.json({
      success: true,
      message: 'Document verified successfully',
    });
  } catch (error) {
    console.error('Error verifying document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify document',
      error: error.message,
    });
  }
});

// Reject document (for authorized issuers)
router.post('/:documentId/reject', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { reason } = req.body;
    const issuerAddress = req.user.address;
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required',
      });
    }
    
    // Check if user is authorized issuer
    const isAuthorized = await blockchainService.isAuthorizedIssuer(issuerAddress);
    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You are not an authorized issuer.',
      });
    }
    
    // Reject document on blockchain
    await blockchainService.rejectDocument(documentId, reason);
    
    // Update database
    await Document.update(
      { 
        status: 'rejected', 
        rejectedBy: issuerAddress, 
        rejectedAt: new Date(),
        rejectionReason: reason 
      },
      { where: { blockchainId: documentId } }
    );
    
    // Get document owner for notification
    const blockchainDoc = await blockchainService.getDocument(documentId);
    
    // Emit real-time update
    const io = req.app.get('io');
    io.to(`citizen-${blockchainDoc.owner}`).emit('document-rejected', {
      documentId,
      reason,
      rejectedBy: issuerAddress,
    });
    
    res.json({
      success: true,
      message: 'Document rejected successfully',
    });
  } catch (error) {
    console.error('Error rejecting document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject document',
      error: error.message,
    });
  }
});

module.exports = router;
