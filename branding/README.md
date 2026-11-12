# Default branding

Put your company logo here as `logo.png` (or `logo.svg` / `logo.jpg`) and, optionally, a
`company.json` like:

```json
{ "company": "Your Company Pty Ltd", "accent": "#d38b00", "site": "Mine site name", "footer": "Prepared by Fleet Engineering" }
```

Then run `npm run build`. The logo and name are embedded in `dist/FleetProductivityAnalyzer.html`
so every copy you hand out is already branded. Users can still change them under **Settings**.
