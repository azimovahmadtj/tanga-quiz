# Танга — сайт + панели админ + пойгоҳи додаҳо (Firebase)

```
tanga-firebase/
├── public/
│   ├── index.html          ← сайт барои бозингарон
│   ├── admin/index.html    ← панели админ (алоҳида, бо рамзи махсус)
│   ├── fb.js               ← пайвастшавӣ ба Firebase (барои ҳарду)
│   └── firebase-config.js  ← калидҳои лоиҳаи шумо (инро пур мекунед)
├── firestore.rules         ← қоидаҳои амнияти пойгоҳ
└── firebase.json           ← танзими хостинг
```

## 1. Лоиҳаи Firebase созед
1. Ба https://console.firebase.google.com равед → **Add project**. Номаш, масалан, `tanga`.
2. **Build → Firestore Database → Create database**. Ҳолати **production**-ро интихоб кунед. Минтақаро наздиктар интихоб кунед, масалан `europe-west`.
3. **Build → Authentication → Get started → Sign-in method**. **Email/Password** ва **Google**-ро фаъол кунед.
4. **Project settings (⚙️) → General → Your apps → Web (</>)**. Барномаро сабт кунед ва объекти `firebaseConfig`-ро нусхабардорӣ кунед.
5. Қиматҳоро ба файли `public/firebase-config.js` гузоред.

## 2. Ба интернет бароред
Ба Node.js ниёз доред:
```bash
npm install -g firebase-tools
firebase login
cd tanga-firebase
firebase use --add          # лоиҳаи худро интихоб кунед
firebase deploy             # ҳам сайт, ҳам қоидаҳои пойгоҳ бор мешаванд
```
Баъд аз ин сайт дар ин суроғаҳо кор мекунад:
- Сайт: `https://<PROJECT_ID>.web.app`
- Панели админ: `https://<PROJECT_ID>.web.app/admin`

## 3. Худро админ кунед (як бор)
1. **Authentication → Users → Add user**. Почтаи худ ва **рамзи махсус**-ро нависед. Ин рамзи воридшавӣ ба панел мешавад.
2. **User UID**-и ин корбарро нусхабардорӣ кунед.
3. **Firestore → Start collection** → номаш `admins` → **Document ID** = ҳамон UID. Майдон: `role` = `admin`.
4. Ба `/admin` равед ва бо ҳамон почта ва рамз ворид шавед.

Касе, ки дар `admins` нест, панелро кушода наметавонад. Агар ворид ҳам шавад, фавран берун карда мешавад. Қоидаҳои `firestore.rules` дар сервер ба ӯ иҷозат намедиҳанд, ки чизеро тағйир диҳад ё тамосҳоро хонад.

## 4. Санҷиш дар компютер
Файлҳоро бо дубора пахш кардан (`file://`) кушодан **кор намекунад**. Сервери хурд лозим аст:
```bash
firebase serve              # ё: npx serve public
```
Дар Authentication → Settings → **Authorized domains** `localhost` бояд бошад. Бо пешфарз ҳаст.

## Маҳдудиятҳое, ки бояд донед
- **Тангаҳо дар браузери бозингар ҳисоб мешаванд.** Корбари доно метавонад тангаҳои худро қалбакӣ кунад. Пеш аз додани мукофоти калон ҳисобро ба **Cloud Functions** гузаронидан лозим аст. Инро баъдтар якҷоя месозем.
- **Ҷавоби дуруст дар ҳуҷҷати савол** ҳаст. Барои санҷиши ҷиддӣ ин ҳам бояд ба Cloud Functions гузарад.
- Нақшаи ройгони **Spark** дар як рӯз ~50 000 хондан ва 20 000 навиштанро медиҳад. Барои аввал кифоя аст.
- Суратҳои профил (≈10 KB) дар худи Firestore нигоҳ дошта мешаванд. Агар корбарон бисёр шаванд, беҳтар аст онҳоро ба **Firebase Storage** гузаронем.
