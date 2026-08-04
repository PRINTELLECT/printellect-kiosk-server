import { db, auth } from './firebase.js';
import { signInAnonymously } from 'firebase/auth';
import { collection, query, where, onSnapshot, getDocs, doc, updateDoc } from 'firebase/firestore';
import ptp from 'pdf-to-printer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

// Global load trackers for balancing
let pendingBwPages = 0;
let pendingColorPages = 0;

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`unexpected response ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(destination, buffer);
}

function promptUser(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function setupPrinters() {
  console.log('Fetching available printers...');
  const printers = await ptp.getPrinters();
  
  if (printers.length === 0) {
    console.error('No printers found on this system!');
    process.exit(1);
  }

  console.log('\n--- Printer Configuration Setup ---');
  console.log('We will list each printer found on your system.');
  console.log('Please assign each printer to a role.\n');

  let bwPrinter = null;
  let colorPrinter = null;

  for (const p of printers) {
    const name = p.name || p;
    let valid = false;
    while (!valid) {
      const ans = await promptUser(`Printer: "${name}"\nAssign to -> [1] B&W, [2] Color, [3] Skip : `);
      if (ans === '1') {
        bwPrinter = name;
        valid = true;
      } else if (ans === '2') {
        colorPrinter = name;
        valid = true;
      } else if (ans === '3') {
        valid = true;
      } else {
        console.log('Invalid input. Please enter 1, 2, or 3.');
      }
    }
  }

  if (!bwPrinter && !colorPrinter) {
    console.warn('\n[WARNING] You did not select any printers! The daemon might crash when trying to print.');
  }

  const config = {
    bwPrinter: bwPrinter,
    colorPrinter: colorPrinter,
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log('\n✅ Configuration saved to config.json');
  return config;
}

async function startDaemon() {
  const args = process.argv.slice(2);
  const isSetup = args.includes('--setup');
  const sessionId = args.find(arg => arg !== '--setup');
  
  if (!sessionId) {
    console.error('Usage: node index.js <SESSION_ID> [--setup]');
    process.exit(1);
  }

  let config;
  if (isSetup || !fs.existsSync(CONFIG_PATH)) {
    console.log('Running setup...');
    config = await setupPrinters();
  } else {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  console.log('\n--- Kiosk Configuration ---');
  console.log(`B&W Printer   : ${config.bwPrinter}`);
  console.log(`Color Printer : ${config.colorPrinter}`);
  console.log('---------------------------\n');

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

  console.log('Listening for print jobs (waiting for payment confirmation)...');

  onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      const jobId = change.doc.id;
      const jobData = change.doc.data();

      // Only process when the job has been paid for and status moved to 'printing'
      if (jobData.status === 'printing' && jobData.shopid) {
        // We might want to ensure we only print it once, so we could track jobs in a Map
        // But for simplicity, we assume we just pick it up once it switches to 'printing'
        if (change.type === 'added' || change.type === 'modified') {
          console.log(`\n[PAYMENT CLEARED] Processing Job ID: ${jobId}`);
          await processJob(jobId, jobData, config);
        }
      }
    });
  }, (error) => {
    console.error('Firestore Listener Error:', error);
  });
}

async function processJob(jobId, jobData, config) {
  try {
    const taskDocRef = doc(db, 'tasks', jobId);
    
    // In Printellect architecture, files for a task are usually stored in a subcollection `files`
    const filesRef = collection(db, `tasks/${jobId}/files`);
    const filesSnap = await getDocs(filesRef);
    
    if (filesSnap.empty) {
      console.log(`[INFO] No files found in tasks/${jobId}/files.`);
      return;
    }

    const tempDir = os.tmpdir();

    for (const fileDoc of filesSnap.docs) {
      const fileData = fileDoc.data();
      const downloadUrl = fileData['file-url'] || fileData.downloadUrl;
      const fileName = fileData['file-name'] || `job_${jobId}_${fileDoc.id}.pdf`;
      const isColor = fileData['color'] === true;
      
      const copies = fileData['copies'] || 1;
      const pages = fileData['total-pages'] || 1;
      const totalFilePages = copies * pages;
      
      let targetPrinter;

      if (isColor) {
        // Color jobs MUST go to color printer
        targetPrinter = config.colorPrinter;
        pendingColorPages += totalFilePages;
      } else {
        // B&W jobs load balancing
        if (pendingBwPages > pendingColorPages) {
          targetPrinter = config.colorPrinter;
          pendingColorPages += totalFilePages;
        } else {
          // If equal or color > bw, send to B&W
          targetPrinter = config.bwPrinter;
          pendingBwPages += totalFilePages;
        }
      }

      if (downloadUrl) {
        console.log(`Downloading ${fileName}...`);
        const filePath = path.join(tempDir, fileName);
        await downloadFile(downloadUrl, filePath);
        
        console.log(`Routing ${fileName} (${totalFilePages} pages) to [${isColor ? 'COLOR' : 'B&W'}] printer: ${targetPrinter}`);
        console.log(`Current Load -> B&W: ${pendingBwPages} pages | Color: ${pendingColorPages} pages`);
        
        try {
          // Print the file to the mapped printer
          await ptp.print(filePath, { printer: targetPrinter });
          console.log(`✅ Successfully printed ${fileName}`);
        } finally {
          // Decrement load tracker
          if (targetPrinter === config.colorPrinter) {
            pendingColorPages -= totalFilePages;
          } else {
            pendingBwPages -= totalFilePages;
          }
          
          // Cleanup temp file
          fs.unlinkSync(filePath);
        }
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
