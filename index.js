import { db, auth } from './firebase.js';
import { signInAnonymously } from 'firebase/auth';
import { collection, query, where, onSnapshot, getDocs, doc, updateDoc } from 'firebase/firestore';
import * as printer from './printer.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

// Global load trackers for balancing
let pendingBwPages = 0;
let pendingColorPages = 0;
const processingJobs = new Set();

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
  const printers = await printer.getPrinters();
  
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

      // Only process when the job has been paid for and status moved to 'on-queue'
      if (jobData.status === 'on-queue' && jobData.shopid) {
        if (processingJobs.has(jobId)) {
          return;
        }
        processingJobs.add(jobId);
        console.log(`\n[PAYMENT CLEARED] Processing Job ID: ${jobId}`);
        await processJob(jobId, jobData, config);
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

    let printedOnBw = false;
    let printedOnColor = false;
    let hasColorFile = false;
    let hasBwFile = false;

    for (const fileDoc of filesSnap.docs) {
      const fileData = fileDoc.data();
      const downloadUrl = fileData['file-url'] || fileData.downloadUrl;
      const fileName = fileData['file-name'] || `job_${jobId}_${fileDoc.id}.pdf`;
      const isColor = fileData['color'] === true;
      if (isColor) hasColorFile = true;
      else hasBwFile = true;
      
      const copies = fileData['copies'] || 1;
      const pages = fileData['total-pages'] || 1;
      const totalFilePages = copies * pages;
      
      let targetPrinter;

      if (isColor) {
        // Color jobs MUST go to color printer (Tray 2)
        if (!config.colorPrinter) {
          console.error(`[ERROR] Color printer not configured! Cannot print color file ${fileName}.`);
          continue;
        }
        targetPrinter = config.colorPrinter;
        pendingColorPages += totalFilePages;
      } else {
        // B&W jobs prefer B&W printer (Tray 1), but can load-balance to color printer (Tray 2)
        if (config.bwPrinter && config.colorPrinter) {
          if (pendingBwPages > pendingColorPages) {
            // Load balance to color printer (it handles both B&W and Color)
            targetPrinter = config.colorPrinter;
            pendingColorPages += totalFilePages;
          } else {
            targetPrinter = config.bwPrinter;
            pendingBwPages += totalFilePages;
          }
        } else if (config.bwPrinter) {
          targetPrinter = config.bwPrinter;
          pendingBwPages += totalFilePages;
        } else if (config.colorPrinter) {
          targetPrinter = config.colorPrinter;
          pendingColorPages += totalFilePages;
        }
      }

      if (downloadUrl) {
        console.log(`Downloading ${fileName}...`);
        const filePath = path.join(tempDir, fileName);
        
        try {
          await downloadFile(downloadUrl, filePath);
          
          const trayLabel = (targetPrinter === config.colorPrinter) ? 'Tray 2' : 'Tray 1';
          console.log(`Routing ${fileName} (${totalFilePages} pages) to [${isColor ? 'COLOR' : 'B&W'}] printer: ${targetPrinter || 'System Default'} [${trayLabel}]`);
          console.log(`Current Load -> B&W: ${pendingBwPages} pages | Color: ${pendingColorPages} pages`);
          
          // Pass printer and layout options
          const printOptions = {
            copies: copies,
            color: isColor,
            duplex: fileData['fb'] === true ||
                    fileData['front-back'] === true ||
                    fileData['duplex'] === true ||
                    String(fileData['fb']).toLowerCase() === 'true' ||
                    String(fileData['front-back']).toLowerCase() === 'true',
          };
          if (targetPrinter) printOptions.printer = targetPrinter;
          
          // Print the file to the mapped printer
          try {
            await printer.print(filePath, printOptions);
            console.log(`✅ Successfully printed ${fileName} on ${targetPrinter || 'Default'}`);
            if (targetPrinter === config.colorPrinter) {
              printedOnColor = true;
            } else {
              printedOnBw = true;
            }
          } catch (printErr) {
            console.error(`⚠️ Error printing to ${targetPrinter || 'Default'}: ${printErr.message}.`);
            
            // Fallback logic:
            // Color jobs CANNOT fall back to B&W printer (would lose color).
            // B&W jobs CAN fall back to Color printer.
            if (!isColor && targetPrinter === config.bwPrinter && config.colorPrinter) {
              try {
                console.log(`[FALLBACK] Routing B&W file ${fileName} to Color Printer (Tray 2): ${config.colorPrinter}`);
                await printer.print(filePath, { ...printOptions, printer: config.colorPrinter, color: false });
                console.log(`✅ Successfully printed ${fileName} on fallback printer (${config.colorPrinter})`);
                printedOnColor = true;
              } catch (fallbackErr) {
                console.error(`❌ Fallback to Color Printer also failed for ${fileName}:`, fallbackErr);
              }
            } else if (isColor) {
              console.error(`❌ Fallback skipped: Color job ${fileName} cannot be sent to B&W printer.`);
            } else {
              console.error(`❌ No suitable fallback printer available for ${fileName}.`);
            }
          }
        } catch (err) {
          console.error(`❌ Error downloading/processing file ${fileName}:`, err);
        } finally {
          // ALWAYS Decrement load tracker to prevent permanent counter skew
          if (targetPrinter === config.colorPrinter) {
            pendingColorPages -= totalFilePages;
          } else {
            pendingBwPages -= totalFilePages;
          }
          
          // Cleanup temp file safely
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
            } catch (_) {}
          }
        }
      }
    }

    // Determine collection trays for output
    const collectionTrays = [];
    if (printedOnBw) collectionTrays.push('Tray 1');
    if (printedOnColor) collectionTrays.push('Tray 2');
    
    // In case tracking was indeterminate (e.g. single printer or test), fallback based on file composition
    if (collectionTrays.length === 0) {
      if (hasBwFile) collectionTrays.push('Tray 1');
      if (hasColorFile) collectionTrays.push('Tray 2');
      if (collectionTrays.length === 0) collectionTrays.push('Tray 1');
    }

    console.log(`\n🎉 [KIOSK OUTPUT] Job ${jobId} finished! Collection Tray(s): ${collectionTrays.join(' and ')}`);

    // Update Firestore status to 'completed' with collection tray information
    await updateDoc(taskDocRef, {
      status: 'completed',
      'completed-time': new Date(),
      'collection-trays': collectionTrays,
    });
    console.log(`Updated job ${jobId} status to completed with collection-trays.`);
  } catch (error) {
    processingJobs.delete(jobId);
    console.error(`[ERROR] Failed to process job ${jobId}:`, error);
  }
}

startDaemon();
