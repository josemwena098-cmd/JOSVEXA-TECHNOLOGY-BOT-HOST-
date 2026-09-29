# JOSVEXA TECHNOLOGY BOT HOST

Panel ya kuhost bots: Firebase (login + database) + bot-hosting.net API (seva ya bots).

## Muundo
- `public/index.html` - UI (login, upload, namba ya simu, console, restart)
- `server.js` - seva inayoshika API key kwa siri na kuongea na bot-hosting.net
- `database.rules.json` - rules za Firebase Realtime Database

## Kwa nini kuna seva?
API key ya bot-hosting.net (`bhk_...`) ni siri. Ukiiweka kwenye HTML, mtu yeyote ataiona
(View Source) na kuchezea bots zote za akaunti yako. Kwa hiyo seva ndiyo inayoishika.

## Hatua za kuwasha
1. **Tengeneza key MPYA** kwenye bot-hosting.net/developer (ile uliyotuma kwenye chat ichukulie kama imevuja, ifute).
   Scopes: `deployments:read`, `deployments:write`, `deployments:power`, `files:read`, `files:write`, `env:read`, `env:write`.
2. Firebase Console > Authentication > Sign-in method > washa **Email/Password**.
3. Firebase Console > Authentication > **Settings > User actions** > ondoa tiki ya **Enable create (sign-up)**
   ili mtu yeyote asiweze kujisajili. (Seva pia inakataa akaunti ambazo hujazitengeneza wewe.)
4. Firebase Console > Authentication > Users > **Add user**: tengeneza akaunti yako ya admin (email + password).
5. Firebase Console > Realtime Database > Rules > bandika `database.rules.json` > **Publish**.
6. Firebase Console > Project settings > Service accounts > **Generate new private key**, ihifadhi kama `serviceAccount.json` ndani ya folda hii.
7. Faili `.env` lipo tayari. Fungua na ubadilishe `ADMIN_EMAIL` kuwa email ya hatua 4 (key ya bot-hosting imeshawekwa; ukitengeneza mpya, ibadilishe hapo).
8. `npm install && npm start` (Node 18 au zaidi), kisha fungua http://localhost:3000 na uingie kama admin.
9. Kwenye kichupo cha **Watumiaji**, tengeneza email na password kwa kila mtu. Mpe wahusika; ndipo wanaweza kuingia.

Kuiweka mtandaoni: pakia folda hii kwenye VPS/Render/Railway/bot-hosting.net, weka variables za `.env`, start command `npm start`.
Kama seva iko kwenye domain tofauti na Firebase, ongeza domain hiyo kwenye Authentication > Settings > Authorized domains.

## Mtiririko wa mtumiaji
Ingia > upload bot (.js/.py/.json au .zip) > weka namba ya simu (env `PHONE_NUMBER` + `OWNER_NUMBER` + `phone.txt`) >
bot ina-restart > console ya live, command box, na Washa / Restart / Zima.

## Mambo ya kujua
- Kila mtumiaji anapata deployment yake, na inatumia "slot" moja kwenye quota ya akaunti yako ya bot-hosting.net.
- API ya bot-hosting.net inapokea faili za maandishi tu; kwenye .zip, mafaili ya binary (picha n.k.) yanarukwa.
- `node_modules` haipakiwi; weka `package.json` ili packages zisakinishwe kwenye seva yao.
- API ina limit ya requests 120/dakika kwa key; seva ina cache ndogo kwa logs na status kulinda hilo.
- Majina ya runtime (`nodejs`, `python`) yakikataliwa, rekebisha `RUNTIME_NODE` / `RUNTIME_PYTHON` kwenye `.env`.
- Bot yako isome namba kwa `process.env.PHONE_NUMBER` (Node) au `os.environ["PHONE_NUMBER"]` (Python).
