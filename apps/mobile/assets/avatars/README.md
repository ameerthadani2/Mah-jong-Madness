# Avatar art

Drop finished portrait images here, named after the character id:

`auntie` `uncle` `grandma` `boss` `lady` `shades` `hoops` `cowboy` `student` `chef` `sporty` `gent`

Any of `.png`, `.jpg`, `.jpeg` or `.webp` at any size works (square is best, 1024×1024 ideal).
On push, the **Import avatar art** GitHub workflow crops and shrinks each one to 384×384 PNG and
switches the app to use it. Characters without an image keep their drawn portrait.

Prompts for generating the set: `docs/AVATAR_PROMPTS.md`.
