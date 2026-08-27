# Research UI

Die Oberfläche für die Postfach-Recherche. Reines HTML, CSS und JavaScript –
kein Framework, kein Build-Schritt, keine Fremdabhängigkeit.

> **Diese Dateien gehören in ein eigenes, öffentliches Repository**
> (`GMX_search_ui`). Sie liegen hier nur, weil das öffentliche Repository aus
> der Entwicklungsumgebung nicht angelegt werden kann. Der Übertragungsweg und
> die manuellen Schritte stehen in [`../docs/frontend.md`](../docs/frontend.md).

## Warum das öffentlich sein darf

Die Seite enthält kein Geheimnis. Der private Schlüssel entsteht im Browser als
**nicht exportierbarer** WebCrypto-Schlüssel und existiert nirgendwo sonst; der
GitHub-Token wird vom Nutzer eingegeben und liegt ausschließlich im
Arbeitsspeicher des Tabs – nicht in `localStorage`, nicht in `sessionStorage`,
nicht in einem Cookie.

Was das kostet: Ein Neuladen der Seite verlangt den Token erneut, und ein
geschlossener Tab macht ein laufendes Ergebnis unlesbar. Beides ist Absicht.
Vor dem Schließen während eines Laufs warnt die Seite.

## Struktur

```
index.html          Oberfläche, Content-Security-Policy im <meta>-Tag
styles.css          ein Stylesheet, keine Web-Fonts
config.js           öffentliche Konfiguration – niemals Geheimnisse
src/
  main.js           Einstiegspunkt
  app.js            Ablauf: verbinden, starten, verfolgen, anzeigen
  github.js         der einzige Ort, der mit GitHub spricht
  crypto.js         ECDH-P256 + HKDF-SHA256 + AES-256-GCM (WebCrypto)
  session.js        was gehalten wird, und wie es wieder verschwindet
  render.js         DOM-Aufbau; Mailinhalte immer als Text, nie als Markup
  query-preview.js  welche Suchbegriffe der Auftrag erzeugt
  text.js           Normalisierung und deutsche Schreibvarianten
  query-data.js     GENERIERT aus dem Backend – nicht von Hand ändern
tests/              Tests, Node-eigener Runner, ohne Dependencies
```

## Tests

```bash
node --test "tests/*.test.mjs"      # oder: npm test
```

Geprüft werden unter anderem: dass Betreffzeilen, Absender, Dateinamen und
Textausschnitte niemals als HTML interpretiert werden; dass der Token nur im
`Authorization`-Header auftaucht; dass „Verbindung trennen“ alles löscht; und
dass kein Modul `innerHTML`, `eval` oder eine fremde Quelle verwendet.

Zwei weitere Tests liegen im Backend-Repository, weil sie beide Sprachen
brauchen:

* `tests/test_crypto_interop.py` – JavaScript verschlüsselt, Python
  entschlüsselt und umgekehrt. Ohne diesen Test könnte eine Abweichung erst im
  Produktivbetrieb auffallen, nach einem Lauf über das echte Postfach.
* `tests/test_query_preview_parity.py` – die angezeigten Suchbegriffe müssen
  exakt die sein, die der Runner verwendet.

## Konfiguration

`config.js` enthält ausschließlich öffentliche Werte: Kontoname, Repository,
Workflow-Datei, Ergebnis-Branch. Kein Token, kein Schlüssel, keine Adresse aus
dem Postfach – auch nicht als Beispiel.

## Token

Fine-grained PAT, beschränkt auf das eine Backend-Repository:

| Berechtigung | Wert | wofür |
|---|---|---|
| Actions | Read and write | Recherche starten, Laufstatus lesen |
| Contents | Read-only | verschlüsseltes Ergebnis abrufen |
| Metadata | Read-only | von GitHub automatisch verlangt |
| alles Übrige | No access | |

Schreibrechte auf Repository-Inhalte sind nicht nötig: Geschrieben wird
ausschließlich vom Workflow mit dessen eigenem Token.
