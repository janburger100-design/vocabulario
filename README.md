# Vocabulario

Spanisch-Karteikarten als installierbare Web-App (PWA). Läuft offline, gleicht den Lernstand über Firebase ab.

- `docs/` – fertige App, so wie sie veröffentlicht wird
- `src/` – Quellcode, `src/vocab.json` enthält die Vokabeln
- `docs/config.js` – Firebase-Zugangsdaten (leer = nur lokal)
- `firestore.rules` – Sicherheitsregeln: jeder liest und schreibt nur seine eigenen Daten
- `./build.sh` – baut `docs/app.js` und aktualisiert den Offline-Cache
