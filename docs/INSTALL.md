# Installing Officina

Officina is one program. Everything it saves (notes, files, browser logins, settings) stays in its own
folder; nothing is shared with your other browsers or apps.

## Windows

1. Put `Officina.exe` in a folder of its own, for example `Documents\Officina`.
2. Double-click it. Windows SmartScreen may say "Windows protected your PC" because the app is not signed
   with a paid certificate: click **More info**, then **Run anyway**.
3. Officina keeps its data in `Officina-Data`, next to the exe.

## macOS

Use the build for your Mac: **arm64** for Apple Silicon (M1 and newer), **x64** for Intel Macs
(Apple menu → About This Mac shows which one you have).

1. Open the `.dmg` and drag **Officina** into **Applications**.
2. Open Officina from Applications. The first time, macOS says it cannot check the app for malware,
   because the app is not notarised with a paid Apple developer account:
   - click **Done** (or OK),
   - open **System Settings → Privacy & Security**, scroll down to the message about Officina and click
     **Open Anyway**, then confirm.
3. Officina keeps its data in `~/Library/Application Support/Officina/Officina-Data`.

If macOS says the app "is damaged", run this once in Terminal and open it again:

```bash
xattr -dr com.apple.quarantine /Applications/Officina.app
```

## First start

- Officina downloads Brave (its browser, about 250 MB) into its own folder the first time. Your own Brave
  is not touched.
- To use the built-in AI agents, open **Assistant → Change** and install the model engine; models from
  LM Studio or Ollama on the same computer are found automatically.
