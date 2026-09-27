// Firebase bridge for Танга — shared by the site (/) and the admin panel (/admin/)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
         collection, query, where, limit, getDocs, addDoc,
         serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
         signOut, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig, appCheckSiteKey } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
// App Check: only requests from this site (not scripts or bots) are accepted once it is enforced in the console
if (appCheckSiteKey) {
  const { initializeAppCheck, ReCaptchaV3Provider } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js");
  initializeAppCheck(app, { provider: new ReCaptchaV3Provider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
}
const fdb = initializeFirestore(app, { ignoreUndefinedProperties: true });
const auth = getAuth(app);
const fns = getFunctions(app, "europe-west1");

const snap = s => ({ id: s.id, exists: s.exists(), data: () => s.data() });
function D(path) {
  const r = doc(fdb, path);
  return {
    get: async () => snap(await getDoc(r)),
    set: (d, o) => (o ? setDoc(r, d, o) : setDoc(r, d)),
    update: d => updateDoc(r, d),
    delete: () => deleteDoc(r),
    onSnapshot: (cb, err) => onSnapshot(r, s => cb(snap(s)), err),
  };
}
function C(path, cons = []) {
  const base = collection(fdb, path);
  const q = () => (cons.length ? query(base, ...cons) : base);
  return {
    where: (f, o, v) => C(path, [...cons, where(f, o, v)]),
    limit: n => C(path, [...cons, limit(n)]),
    get: async () => ({ docs: (await getDocs(q())).docs.map(snap) }),
    onSnapshot: (cb, err) => onSnapshot(q(), s => cb({ docs: s.docs.map(snap) }), err),
    add: d => addDoc(base, d),
    doc: id => D(path + "/" + id),
  };
}

window.FB = {
  db: { doc: D, collection: C },
  onAuth: cb => onAuthStateChanged(auth, cb),
  signUp: (email, pass) => createUserWithEmailAndPassword(auth, email, pass),
  signIn: (email, pass) => signInWithEmailAndPassword(auth, email, pass),
  google: () => signInWithPopup(auth, new GoogleAuthProvider()),
  signOut: () => signOut(auth),
  reset: email => sendPasswordResetEmail(auth, email),
  deleteMe: () => deleteUser(auth.currentUser),
  // Answers are checked and coins added only on the server (functions/game.js)
  call: (name, data) => httpsCallable(fns, name)(data).then(r => r.data),
  // Creates the player's score at registration. A new nickname is reserved in /nicks in the same atomic
  // batch, so the security rules can check both together. Progress itself is only written by the server.
  writeScore: (uid, me, { claimNick = false, oldNickLower = "", contact = null } = {}) => {
    const data = { ...me, updatedAt: Date.now(), srvAt: serverTimestamp() };
    const b = writeBatch(fdb);
    b.set(doc(fdb, "scores/" + uid), data, { mergeFields: Object.keys(data).filter(k => data[k] !== undefined) });
    if (claimNick && me.nickLower) b.set(doc(fdb, "nicks/" + me.nickLower), { uid });
    if (oldNickLower && oldNickLower !== me.nickLower) b.delete(doc(fdb, "nicks/" + oldNickLower));
    if (contact) b.set(doc(fdb, "contacts/" + uid), contact);
    return b.commit();
  },
  // Profile changes only: nickname, photo, the player's own mistakes list
  writeProfile: (uid, fields, { claimNick = false, oldNickLower = "", contact = null } = {}) => {
    const data = { ...fields, updatedAt: Date.now(), srvAt: serverTimestamp() };
    const b = writeBatch(fdb);
    b.set(doc(fdb, "scores/" + uid), data, { mergeFields: Object.keys(data).filter(k => data[k] !== undefined) });
    if (claimNick && fields.nickLower) b.set(doc(fdb, "nicks/" + fields.nickLower), { uid });
    if (oldNickLower && fields.nickLower && oldNickLower !== fields.nickLower) b.delete(doc(fdb, "nicks/" + oldNickLower));
    if (contact) b.set(doc(fdb, "contacts/" + uid), contact);
    return b.commit();
  },
  // Admin: the question is public, its correct option goes to the admin-only /answers collection
  addQuestion: (q, correct) => {
    const r = doc(collection(fdb, "questions")), b = writeBatch(fdb);
    b.set(r, q); b.set(doc(fdb, "answers/" + r.id), { correct });
    return b.commit();
  },
  deleteQuestion: id => {
    const b = writeBatch(fdb);
    b.delete(doc(fdb, "questions/" + id)); b.delete(doc(fdb, "answers/" + id));
    return b.commit();
  },
  nickOwner: async lower => { const s = await getDoc(doc(fdb, "nicks/" + lower)); return s.exists() ? s.data().uid : null; },
  deleteMine: (uid, nickLower) => {
    const b = writeBatch(fdb);
    b.delete(doc(fdb, "scores/" + uid)); b.delete(doc(fdb, "contacts/" + uid));
    if (nickLower) b.delete(doc(fdb, "nicks/" + nickLower));
    return b.commit();
  },
  isAdmin: async uid => { try { return (await getDoc(doc(fdb, "admins/" + uid))).exists(); } catch (e) { return false; } },
};
window.dispatchEvent(new Event("fb-ready"));
