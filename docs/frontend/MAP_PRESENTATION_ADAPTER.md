# Map presentation adapter

`web/core/map-presentation.mjs` owns frontend-only map presentation state:
theme, UI locale, style identity and fallback semantics. It does not own map
data, coordinates, markers, clustering, popups or bounds.

The only confirmed production basemap is the frozen canonical style in
`web/map.js`: Stadia Maps Alidade Smooth Dark with its existing attribution.
Dark mode uses that style directly.

No confirmed light-mode tile URL or attribution has been supplied. Therefore
light mode intentionally keeps the same canonical raster basemap and exposes
the explicit `preserve-canonical-dark-basemap` fallback state. The application
shell and Leaflet attribution adapt to the light token family; no guessed URL,
provider or synthetic layer is introduced.

Locale changes are propagated to the map's application-owned labels, tooltips
and popup presentation through the existing presentation dictionary. Raster
tile labels are provider-baked and remain unchanged until a verified compatible
provider/style is available.
