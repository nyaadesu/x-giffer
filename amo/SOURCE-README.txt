X Giffer: source code for addons.mozilla.org review
====================================================

There is NO build step. The add-on package is the extension/ directory zipped as-is:

    npx web-ext build -s extension

(web-ext 10.x, Node 18+). Every file in extension/ is hand-written, unminified JavaScript,
except for one third-party library:

    extension/vendor/gifenc.js = gifenc 1.0.3 by Matt DesLauriers (MIT), unmodified
      npm:    https://registry.npmjs.org/gifenc/-/gifenc-1.0.3.tgz  -> package/dist/gifenc.esm.js
      unpkg:  https://unpkg.com/gifenc@1.0.3/dist/gifenc.esm.js
      repo:   https://github.com/mattdesl/gifenc
      sha256: 217761244379253ba5815510d3048a4fb1f4c4dbe9fb51a5cfbfe26f34eec093

Other directories (pwa/, amo/, .github/) are not part of the add-on: pwa/ is a companion web
app hosted on GitHub Pages, and amo/ holds listing text.

Repository: https://github.com/nyaadesu/x-giffer
