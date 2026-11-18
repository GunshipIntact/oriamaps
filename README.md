# OriaMaps

A map and route planner for our Minecraft world, made to run for free on GitHub Pages.

Live address (once switched on): https://gunshipintact.github.io/oriamaps/

## What is in this folder

| Path | What it is |
|---|---|
| `index.html` | The page itself |
| `css/style.css` | The Minecraft-style look |
| `js/` | The code: `main.js` (page), `renderer.js` (3D/2D map), `route.js` (route maths), `editor.js` (owner tools), `github.js` (saving), `store.js` (loading), `util.js` (helpers) |
| `data/oriamaps.json` | All shared map data: worlds, dimensions, dots, players, transport speeds |
| `pictures/` | Location pictures you upload through the site (created automatically) |
| `assets/fonts/` | The Minecraft font (by Jacob Debono, free for commercial use) |
| `assets/icons/` | Site icon, link preview picture, dimension blocks |
| `.nojekyll` | Tells GitHub Pages to publish the files exactly as they are |

## Putting the site online (one time)

1. Unzip `oriamaps-site.zip` on your PC.
2. Open your repository `GunshipIntact/oriamaps` on github.com.
3. Click **Add file → Upload files**, drag in everything *inside* the unzipped folder (not the folder itself), and click **Commit changes**.
   - The file `.nojekyll` may be hidden on your PC. If it does not upload, create it on GitHub: **Add file → Create new file**, name it `.nojekyll`, leave it empty, **Commit changes**.
4. Go to **Settings → Pages**. Under "Build and deployment" pick **Deploy from a branch**, branch **main**, folder **/ (root)**, and click **Save**.
5. After 1–2 minutes the site is live at https://gunshipintact.github.io/oriamaps/

## Becoming the owner (one time per browser)

Visitors can only look and plan routes. To change anything you sign in with a GitHub key:

1. On github.com click your profile picture → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Name it `OriaMaps`. Pick an expiration (up to a year; you then make a new one).
3. **Repository access → Only select repositories →** `oriamaps`.
4. Scroll down to **Permissions**. There are two boxes, **Repositories** and **Account**, each with its own **+ Add permissions** button.
   Use the button in the **Repositories** box (the Account list has things like "Followers" and "Email addresses" and no Contents).
   Tick **Contents**, close the list, and next to Contents change **Read-only** to **Read and write**.
   (If there is no Repositories box, step 3 is set to "Public repositories"; change it to "Only select repositories".)
   An existing key can be fixed the same way: open it in the Fine-grained tokens list and click **Edit**.
5. Click **Generate token** and copy it right away (GitHub only shows it once).
6. On OriaMaps click **Owner sign in** (bottom of the blue sidebar), paste the key and press **Sign in**.

The key stays only in that browser. Never send it to anyone. If it leaks, delete it on GitHub (same page) and make a new one.

## Using the owner tools

After signing in, the **Owner tools** bar appears at the bottom of the screen:

- **+ World**: create, rename or delete worlds (name and optional seed). Start here; dots need a world.
- **+ Dot**: add a dot. Pick the dimension and type, the player who found it, a picture and an optional comment.
  Coordinates can be written `x y z`, `x, y, z` or `x/y/z`. If the height is unknown, write only `x z`.
  For a **Portal** you also enter the linked portal's dimension and coordinates (or link an existing portal, or save it as unlinked).
- **Click a dot** on the map to open its panel on the left. There you can **Edit** or **Delete** it.
- **+ Dimension**: add or change dimensions (name, ratio, lowest/highest Y, colour).
- **Players**: add people by the name you know them by (for example their Discord name). Fill in their Minecraft Java
  username to load their face automatically, or upload a face picture. With neither, a default head is shown.
  Press **Look up** next to the Minecraft username to see their face and check that the account exists.
  Renaming a player also renames them on all their dots.
- **Transport**: add or change transport methods and their speeds.

Every change is saved straight into this repository. Everyone sees it within about a minute
(their browser may need a refresh). If saving fails, the bar shows **Retry save**.

## Things I added that were not in the description

- A dashed line from each dot down (or up) to the Y = 0 floor, so you can see how high it is.
- Search also finds players; clicking one shows only their dots.
- Dot names autocomplete in the Starting point, Destination and new-point fields.
- If a point has no dimension written and only one dimension is checked, that dimension is used.
- Your own stopovers in the Router have an **X** to remove them.
- Hovering a Router row shows that dot's bubble.
- A dot without a picture shows its dimension's block instead.
- Player faces: if the first face service fails, a second one is tried, then a plain default head.
- Pictures are shrunk to at most 1280 px before uploading so the site stays fast.
- An unlinked portal's bubble says "Unlinked portal: not used for routes".
- The site remembers each visitor's theme, view, grid and last world.
- Escape closes the left panel and windows.
- The map is drawn with the site's own code (no 3D library), so nothing extra has to be downloaded.
- A tag in `index.html` asks search engines not to list the site.
- The view-size readout (bottom left) also shows the size of one grid square.
- Axis numbers far away are skipped when the perspective would squeeze them together.
- When checking or unchecking dimensions changes the scale (for example Nether alone vs. Nether with Overworld),
  the camera is converted so you keep looking at the same place.
- A dot whose height is unknown is drawn on the Y = 0 floor, shows "Y ?" and a yellow "!", and routes ignore the height difference for it.
- Signing in checks that the key can really change files, so a key without "Contents: Read and write" is refused right away.
- The first world is called "Oria"; rename it any time with + World.

## Testing a copy with sample data

Open `index.html?data=path/to/file.json` to look at another data file from this site
without touching the real one.
