#!/bin/sh
# Replace the firebase-config.js script tag with inline config from env vars
sed -i "s|<script src=\"firebase-config.js\"></script>|<script>window.firebaseConfig={apiKey:\"$FIREBASE_API_KEY\",authDomain:\"$FIREBASE_AUTH_DOMAIN\",projectId:\"$FIREBASE_PROJECT_ID\",storageBucket:\"$FIREBASE_STORAGE_BUCKET\",messagingSenderId:\"$FIREBASE_MESSAGING_SENDER_ID\",appId:\"$FIREBASE_APP_ID\",measurementId:\"$FIREBASE_MEASUREMENT_ID\"};</script>|" index.html
