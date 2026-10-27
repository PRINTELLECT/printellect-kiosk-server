import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyA4qzN_O3AJb-vihYf8li5uKHM3HX-Q-N0',
  appId: '1:784544185309:web:8ed19a777e9456aa00d434',
  messagingSenderId: '784544185309',
  projectId: 'printellectsystems',
  authDomain: 'printellectsystems.firebaseapp.com',
  storageBucket: 'printellectsystems.firebasestorage.app',
  measurementId: 'G-EMZJ2NVTQD',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

export { db, auth };
