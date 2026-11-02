# Avatar art

Drop finished portrait images here, named after the character id:

`auntie` `uncle` `grandma` `boss` `lady` `shades` `hoops` `cowboy` `student` `chef` `sporty` `gent`

Any of `.png`, `.jpg`, `.jpeg` or `.webp` at any size works (square is best, 1024×1024 ideal).
On push, the **Import avatar art** GitHub workflow crops and shrinks each one to 384×384 PNG and
switches the app to use it. Characters without an image keep their drawn portrait.

**Animated clips** (optional): name them `<id>-idle`, `<id>-win` or `<id>-lose` with `.mp4`, `.mov`,
`.webm` or `.gif`, e.g. `cowboy-idle.mp4`. They are converted to small looping animated WebP.
The idle clip plays in that character's seat; win plays when they win a hand, lose when they deal in.

Prompts for generating the stills and the clips: `docs/AVATAR_PROMPTS.md`.
