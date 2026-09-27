// Firebase bridge for Танга — shared by the site (/) and the admin panel (/admin/)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
         collection, query, where, limit, getDocs, addDoc,
         serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
         signOut, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, appCheckSiteKey } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
// App Check: only requests from this site (not scripts or bots) are accepted once it is enforced in the console
if (appCheckSiteKey) {
  const { initializeAppCheck, ReCaptchaV3Provider } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js");
  initializeAppCheck(app, { provider: new ReCaptchaV3Provider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
}
const fdb = initializeFirestore(app, { ignoreUndefinedProperties: true });
const auth = getAuth(app);

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
  // Saves the player's progress. The server stamps the time (srvAt, dayStart), and a new nickname is
  // reserved in /nicks in the same atomic batch, so the security rules can check all of it together.
  writeScore: (uid, me, { resetDay = false, claimNick = false, oldNickLower = "", contact = null } = {}) => {
    const data = { ...me, updatedAt: Date.now(), srvAt: serverTimestamp() };
    delete data.dayStart;
    if (resetDay) data.dayStart = serverTimestamp();
    const b = writeBatch(fdb);
    b.set(doc(fdb, "scores/" + uid), data, { mergeFields: Object.keys(data).filter(k => data[k] !== undefined) });
    if (claimNick && me.nickLower) b.set(doc(fdb, "nicks/" + me.nickLower), { uid });
    if (oldNickLower && oldNickLower !== me.nickLower) b.delete(doc(fdb, "nicks/" + oldNickLower));
    if (contact) b.set(doc(fdb, "contacts/" + uid), contact);
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
