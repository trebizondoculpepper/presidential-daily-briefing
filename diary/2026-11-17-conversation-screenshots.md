# Owner-supplied website conversations (#793)

Added three owner-supplied conversation illustrations to Use cases, with a Home
link, responsive previews and full-resolution image links. Captions describe
implementer priorities, human attention and repository catch-up while attributing
the prose to an assistant using PDB evidence. Historical ticket status and release
availability are not advertised as current product functionality.

These editorial illustrations are separate from the existing release-validated
command examples and do not acquire synthetic capture provenance. The original
bytes are preserved; the third attachment has JPEG encoding despite its supplied
PNG filename, so its public filename uses `.jpg`. Images are copied through an
explicit asset list and remain excluded from the npm CLI package.

Validation: check/build passed; the normal suite passed 2,724 tests with one
existing skip. Focused artifact checks reject missing, substituted or unlisted
images. Real disposable headless Chrome at 1280 and 390 CSS pixels loaded all
three images, captions and full-image links with no horizontal overflow.
The npm dry-run archive excludes the website and image assets. No screen-reader
verification is claimed. The separate image-artifact contract merged as #794.
