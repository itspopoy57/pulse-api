// src/config/firebase.ts
import * as admin from 'firebase-admin';

let firebaseInitialized = false;

// Lazy initialization - only initialize when actually needed
function initializeFirebase() {
  if (firebaseInitialized || admin.apps.length > 0) {
    return;
  }

  // Check if credentials are available
  if (!process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    console.warn('Firebase credentials not configured. Google Sign-In will be disabled.');
    return;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID || 'pulse-32f2c',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    firebaseInitialized = true;
    console.log('Firebase Admin SDK initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error);
  }
}

// Export a proxy that initializes on first use
export const firebaseAdmin = {
  auth: () => {
    initializeFirebase();
    return admin.auth();
  },
  // Add other methods as needed
};