const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

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
          db = admin.firestore();
          console.log('Firebase Admin initialized successfully');
    } catch (error) {
          console.error('Error initializing Firebase Admin:', error);
          process.exit(1);
    }
}

initializeFirebase();

// Initialize Gmail API
async function getGmailService() {
    const auth = new google.auth.GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/gmail.send']
    });
    return google.gmail({ version: 'v1', auth });
}

// Helper function to send email via Gmail API
async function sendEmail(toEmail, subject, body) {
    try {
          const gmail = await getGmailService();
          
          const message = [
                  `From: noreply@ai-schedule-manager.com`,
                  `To: ${toEmail}`,
                  `Subject: ${subject}`,
                  `Content-Type: text/plain; charset="UTF-8"`,
                  '',
                  body
                ].join('\n');
          
          const encodedMessage = Buffer.from(message)
                  .toString('base64')
                  .replace(/\+/g, '-')
                  .replace(/\//g, '_')
                  .replace(/=+$/, '');
          
          await gmail.users.messages.send({
                  userId: 'me',
                  requestBody: {
                            raw: encodedMessage
                  }
          });
          
          console.log('Email sent successfully to:', toEmail);
          return true;
    } catch (error) {
          console.error('Error sending email:', error);
          return false;
    }
}

// Helper function to get Google Calendar events
async function getCalendarEvents(date) {
    try {
          const auth = new google.auth.GoogleAuth({
                  scopes: ['https://www.googleapis.com/auth/calendar.readonly']
          });
          const calendar = google.calendar({ version: 'v3', auth });
          
          // Parse the date
          const startDate = new Date(date);
          startDate.setHours(0, 0, 0, 0);
          const endDate = new Date(date);
          endDate.setHours(23, 59, 59, 999);
          
          const response = await calendar.events.list({
                  calendarId: 'primary',
                  timeMin: startDate.toISOString(),
                  timeMax: endDate.toISOString(),
                  singleEvents: true,
                  orderBy: 'startTime'
          });
          
          return response.data.items || [];
    } catch (error) {
          console.error('Error fetching calendar events:', error);
          return [];
    }
}

// Helper function to calculate priority score
function calculatePriority(schedule, calendarEvents) {
    const subject = schedule.subject || 'Unknown';
    const hoursNeeded = schedule.hours_needed || 1;
    const deadline = schedule.deadline;
    const tagPriority = schedule.priority || 0.5; // 0-1 scale
    
    let urgencyScore = 0;
    
    if (deadline) {
          try {
                  const now = new Date();
                  const deadlineDate = new Date(deadline);
                  const timeToDeadlineHours = (deadlineDate - now) / (1000 * 60 * 60);
                  
                  if (timeToDeadlineHours > 0) {
                            urgencyScore = (hoursNeeded / timeToDeadlineHours) * 0.6 + tagPriority * 0.4;
                  } else {
                            urgencyScore = 10; // High priority if deadline passed
                  }
          } catch (error) {
                  urgencyScore = tagPriority * 0.4;
          }
    } else {
          urgencyScore = tagPriority * 0.4;
    }
    
    return {
          subject,
          hours_needed: hoursNeeded,
          urgency_score: urgencyScore,
          deadline
    };
}

// Existing /capture endpoint
app.post('/capture', async (req, res) => {
    try {
          const { message, rawText, userId, source } = req.body;
          
          if (!message && !rawText) {
                  return res.status(400).json({
                            status: 'error',
                            message: 'Either "message" or "rawText" is required'
                  });
          }
          
          const scheduleData = {
                  userId: userId || 'unknown',
                  source: source || 'api',
                  message: message || rawText,
                  timestamp: new Date().toISOString(),
                  date: new Date().toISOString().split('T')[0]
          };
          
          const docRef = await db.collection('schedules').add(scheduleData);
          
          res.status(201).json({
                  status: 'success',
                  id: docRef.id,
                  data: scheduleData
          });
    } catch (error) {
          console.error('Error in /capture endpoint:', error);
          res.status(500).json({
                  status: 'error',
                  message: error.message
          });
    }
});

// New /briefing endpoint
app.post('/briefing', async (req, res) => {
    try {
          const today = new Date().toISOString().split('T')[0];
          
          // Query Firestore for today's captured schedules
          const schedulesSnapshot = await db.collection('schedules')
                  .where('date', '==', today)
                  .get();
          
          const schedules = [];
          schedulesSnapshot.forEach(doc => {
                  schedules.push(doc.data());
          });
          
          // Get today's Google Calendar events
          const calendarEvents = await getCalendarEvents(today);
          
          // Calculate priorities for all schedules
          const priorities = schedules.map(schedule => 
                  calculatePriority(schedule, calendarEvents)
                                               );
          
          // Sort by urgency score (highest first)
          priorities.sort((a, b) => b.urgency_score - a.urgency_score);
          
          // Build email body
          let emailBody = `📚 Your Study Briefing for ${today}\n\n`;
          emailBody += `Generated at: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })}\n\n`;
          
          emailBody += '📅 TODAY\'S SCHEDULE:\n';
          if (calendarEvents.length > 0) {
                  calendarEvents.forEach(event => {
                            const eventStart = event.start.dateTime || event.start.date;
                            emailBody += `  • ${event.summary} @ ${eventStart}\n`;
                  });
          } else {
                  emailBody += '  No calendar events scheduled\n';
          }
          
          emailBody += '\n🎯 STUDY PRIORITIES (Ranked):\n';
          if (priorities.length > 0) {
                  priorities.forEach((priority, index) => {
                            emailBody += `${index + 1}. ${priority.subject}\n`;
                            emailBody += `   Hours needed: ${priority.hours_needed} | Priority score: ${priority.urgency_score.toFixed(2)}\n`;
                            if (priority.deadline) {
                                        emailBody += `   Deadline: ${priority.deadline}\n`;
                            }
                  });
          } else {
                  emailBody += '  No study tasks scheduled yet\n';
          }
          
          // Send email to Verizon SMS gateway (615-979-3586@vtext.com)
          const smsGatewayEmail = '615-979-3586@vtext.com';
          const emailSent = await sendEmail(
                  smsGatewayEmail,
                  `Study Briefing - ${today}`,
                  emailBody
                );
          
          if (emailSent) {
                  res.status(200).json({
                            status: 'success',
                            message: 'Briefing sent',
                            schedules_count: schedules.length,
                            calendar_events_count: calendarEvents.length,
                            priorities: priorities
                  });
          } else {
                  res.status(500).json({
                            status: 'error',
                            message: 'Failed to send briefing email'
                  });
          }
    } catch (error) {
          console.error('Error in /briefing endpoint:', error);
          res.status(500).json({
                  status: 'error',
                  message: error.message
          });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});onst express = require('express');
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
    const { source, message, timestamp, rawText, userId } = req.body;

    console.log('Capture request received:', { source, message: message?.substring(0, 50), userId });

    // Validate required fields
    if (!source) {
      console.warn('Validation failed: missing source');
      return res.status(400).json({
        success: false,
        error: 'Missing required field: source'
      });
    }

    if (!message) {
      console.warn('Validation failed: missing message');
      return res.status(400).json({
        success: false,
        error: 'Missing required field: message'
      });
    }

    if (!rawText) {
      console.warn('Validation failed: missing rawText');
      return res.status(400).json({
        success: false,
        error: 'Missing required field: rawText'
      });
    }

    // Add document to Firestore
    const docRef = await db.collection('schedules').add({
      source,
      message,
      timestamp: timestamp || new Date().toISOString(),
      rawText,
      userId: userId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('Schedule captured successfully:', { id: docRef.id, source, userId });

    res.status(201).json({
      success: true,
      id: docRef.id,
      message: `Schedule captured successfully from ${source}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error capturing schedule:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
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
