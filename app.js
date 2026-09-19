const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const { Firestore } = require('@google-cloud/firestore');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

let db;

// Initialize Firebase Admin
async function initializeFirebase() {
  try {
    // Initialize Firebase Admin SDK with Application Default Credentials
    // Cloud Run will automatically use the service account attached to it
    admin.initializeApp({
      projectId: 'grounded-tine-509019-e1'
    });

    // Get Firestore instance for the specific database
    db = new Firestore({
      projectId: 'grounded-tine-509019-e1',
      databaseId: 'schedule-manager'
    });

    console.log('Firebase Admin SDK initialized successfully');
    console.log(`Connected to Firestore database: schedule-manager`);
    return db;
  } catch (error) {
    console.error('Error initializing Firebase:', error);
    process.exit(1);
  }
}

// Root endpoint for Cloud Run health checks
app.get('/', (req, res) => {
  console.log('GET / route called');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ status: 'ok' }));
});

// Health check endpoint for Cloud Run
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Capture endpoint
app.post('/capture', async (req, res) => {
  try {
    const { source, message, timestamp, rawText } = req.body;

    // Validate required fields
    if (!source || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: source and message'
      });
    }

    // Add document to Firestore
    const docRef = await db.collection('schedules').add({
      source,
      message,
      timestamp: timestamp || new Date().toISOString(),
      rawText: rawText || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).json({
      success: true,
      id: docRef.id
    });
  } catch (error) {
    console.error('Error capturing schedule:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server after Firebase is initialized
initializeFirebase().then(() => {
  console.log('Firebase initialized, starting server...');
  app.listen(PORT, () => {
    console.log(`Server successfully listening on port ${PORT}`);
    console.log(`Health check: GET /`);
    console.log(`Health check: GET /health`);
    console.log(`Capture endpoint: POST /capture`);
  });
}).catch(error => {
  console.error('Failed to initialize Firebase:', error);
  process.exit(1);
});
