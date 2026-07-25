import { db, auth } from './firebase.js';
import { signInAnonymously } from 'firebase/auth';
import { collection, query, where, onSnapshot, getDocs, doc, updateDoc } from 'firebase/firestore';
import ptp from 'pdf-to-printer';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`unexpected response ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(destination, buffer);
}

async function startDaemon() {
  const sessionId = process.argv[2];
  
  if (!sessionId) {
    console.error('Usage: node index.js <SESSION_ID>');
    process.exit(1);
  }

  console.log('Starting Kiosk Print Daemon...');
  console.log(`Listening for Kiosk Session ID: ${sessionId}`);

  try {
    await signInAnonymously(auth);
    console.log('Connected to Firebase.');
  } catch (error) {
    console.error('Firebase Auth Error:', error);
    process.exit(1);
  }

  const tasksRef = collection(db, 'tasks');
  const q = query(
    tasksRef,
    where('kiosk-session-id', '==', sessionId),
    where('is-kiosk-job', '==', true)
  );

  console.log('Listening for print jobs...');

  onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      const jobId = change.doc.id;
      const jobData = change.doc.data();

      // Only process when the mobile app finishes uploading everything (indicated by setting shopid)
      if (jobData.status === 'requested' && jobData.shopid) {
        // If it's a new or modified doc that reached the ready state
        if (change.type === 'added' || change.type === 'modified') {
          console.log(`\n[NEW JOB] Received Job ID: ${jobId}`);
          await processJob(jobId, jobData);
        }
      }
    });
  }, (error) => {
    console.error('Firestore Listener Error:', error);
  });
}

async function processJob(jobId, jobData) {
  try {
    const taskDocRef = doc(db, 'tasks', jobId);
    
    // Set status to printing
    await updateDoc(taskDocRef, { status: 'printing' });
    console.log(`Updated job ${jobId} status to printing.`);

    // In Printellect architecture, files for a task are usually stored in a subcollection `files`
    const filesRef = collection(db, `tasks/${jobId}/files`);
    const filesSnap = await getDocs(filesRef);
    
    if (filesSnap.empty) {
      console.log(`[INFO] No files found in tasks/${jobId}/files.`);
      // If it's a binding job, it might store file info differently or use a different subcollection name
      // For now, this handles the standard file list
    }

    const tempDir = os.tmpdir();

    for (const fileDoc of filesSnap.docs) {
      const fileData = fileDoc.data();
      const downloadUrl = fileData['file-url'] || fileData.downloadUrl;
      const fileName = fileData['file-name'] || `job_${jobId}_${fileDoc.id}.pdf`;
      
      if (downloadUrl) {
        console.log(`Downloading ${fileName}...`);
        const filePath = path.join(tempDir, fileName);
        await downloadFile(downloadUrl, filePath);
        
        console.log(`Printing ${fileName} to default printer...`);
        
        // Print the file silently to the default Windows printer
        await ptp.print(filePath);
        console.log(`✅ Successfully printed ${fileName}`);
        
        // Cleanup temp file
        fs.unlinkSync(filePath);
      }
    }

    // Update Firestore status to 'completed' and 'delivered' since it's a live kiosk job
    await updateDoc(taskDocRef, {
      status: 'completed',
      'completed-time': new Date(),
      'delivered-time': new Date()
    });
    console.log(`Updated job ${jobId} status to completed.`);
  } catch (error) {
    console.error(`[ERROR] Failed to process job ${jobId}:`, error);
  }
}

startDaemon();
