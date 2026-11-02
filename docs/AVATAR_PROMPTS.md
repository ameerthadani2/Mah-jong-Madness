# Avatar image prompts

Twelve player portraits in the PokerBros vibe: 3D-rendered caricature busts with big heads, big grins and glossy lighting. Generate them with any image model (ChatGPT image generation, Midjourney, Ideogram, Leonardo, Flux…), then upload them to the repo and the app picks them up automatically.

## Rules that make them fit the app

* **Square 1:1**, 1024×1024 or larger.
* **One person, head and shoulders, centred.** The app crops to a circle, so keep the whole head (and hat) inside the middle of the square with a little space above, and let the shoulders run off the bottom edge.
* **Same dark backdrop on every image**: deep indigo-violet with a soft glow behind the head. It matches the seat frames and makes the set look like one family.
* **No text, borders, frames or watermarks.**

## How to keep all twelve consistent

* **ChatGPT**: generate #1 (Lady), then in the same chat say *"Same style, lighting, framing and background as the last image. Now: …"* followed by the next character line.
* **Midjourney**: generate #1, then add `--sref <url of #1>` to the rest; add `--ar 1:1 --style raw` to every prompt.
* **Others**: use the first good image as a style or image reference for the rest.
* Regenerate any face that looks creepy, stiff or off-model. Twelve good ones beat twelve fast ones.

## Prompts

Each prompt below is complete. Copy it as is.

### 1. Lady — save as `lady.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole head visible, looking at the camera. A Taiwanese woman in her late 20s with long straight glossy black hair and a centre part, red lipstick, champagne silk top, delicate gold pendant, elegant confident smile showing teeth. Glossy expressive eyes with catchlights, soft subsurface skin, warm key light from the upper left, cool blue rim light on the right edge, detailed hair highlights. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 2. Auntie — `auntie.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole head visible, looking at the camera. A cheerful Taiwanese auntie in her late 50s with short curly auburn permed hair, pearl stud earrings, coral blouse with small white flowers, warm cheeky grin showing teeth. Glossy expressive eyes with catchlights, soft subsurface skin, warm key light from the upper left, cool blue rim light on the right edge, detailed hair highlights. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 3. Uncle — `uncle.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole head and cap visible, looking at the camera. A relaxed Taiwanese uncle in his 60s wearing a grey tweed flat cap, grey hair at the temples, light stubble, light-blue polo shirt, easy wide smile with smile lines. Glossy expressive eyes with catchlights, soft subsurface skin, warm key light from the upper left, cool blue rim light on the right edge. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 4. Grandma — `grandma.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole head and hair bun visible, looking at the camera. A sweet Taiwanese grandmother in her 70s with silver hair in a neat bun held by a jade hairpin, round thin gold glasses, lilac cardigan over a white collar, kind gentle smile. Glossy expressive eyes with catchlights, soft subsurface skin, warm key light from the upper left, cool blue rim light on the right edge. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 5. The Boss — `boss.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole head visible, looking at the camera. A confident East Asian businessman in his 40s with slicked-back black hair, rectangular black glasses, navy suit, white shirt, red tie with a gold tie clip, smug smirk with one eyebrow raised. Glossy expressive eyes with catchlights, soft subsurface skin, warm key light from the upper left, cool blue rim light on the right edge. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 6. Mr Cool — `shades.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole head visible, facing the camera. A cool Southeast Asian guy in his late 20s with a styled quiff and shaved undercut, gold aviator sunglasses, red open-collar shirt, gold chain, cocky grin showing teeth. Glossy reflections on the sunglasses, soft subsurface skin, warm key light from the upper left, cool blue rim light on the right edge, detailed hair highlights. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 7. Hoops — `hoops.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with all of the hair visible, looking at the camera. A glamorous Black woman in her 30s with big voluminous curly hair, large gold hoop earrings, berry lipstick, bright orange top, laughing with a wide smile. Glossy expressive eyes with catchlights, rich skin with soft highlights, warm key light from the upper left, cool blue rim light on the right edge. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 8. Sheriff — `cowboy.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole cowboy hat visible, looking at the camera. A jolly cowboy in his 50s with a brown cowboy hat bearing a small gold sheriff star, thick horseshoe moustache, blue eyes, red bandana, denim shirt, friendly grin. Glossy expressive eyes with catchlights, soft subsurface skin, warm key light from the upper left, cool blue rim light on the right edge. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 9. Student — `student.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole head visible, looking at the camera. A cheerful Taiwanese university student about 19 years old with messy spiky black hair, red headphones around his neck, mustard-yellow hoodie, big boyish grin. Glossy expressive eyes with catchlights, smooth youthful skin with no wrinkles, warm key light from the upper left, cool blue rim light on the right edge, detailed hair highlights. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 10. Chef — `chef.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole tall chef hat visible, looking at the camera. A jolly Black chef in his 40s with a round face, tall white chef's toque, white double-breasted chef jacket, red neckerchief, big hearty laugh showing teeth. Glossy expressive eyes with catchlights, rich skin with soft highlights, warm key light from the upper left, cool blue rim light on the right edge. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 11. Sporty — `sporty.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole cap and ponytail visible, looking at the camera. An energetic Latina woman in her early 20s wearing a pink baseball cap, brown ponytail, light freckles, cyan athletic zip top, bright friendly smile. Glossy expressive eyes with catchlights, smooth youthful skin with no wrinkles, warm key light from the upper left, cool blue rim light on the right edge. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

### 12. Gentleman — `gent.png`
```
3D rendered stylized caricature portrait for a premium social casino game avatar, Pixar-quality stylized realism, large head and small shoulders, head-and-shoulders bust centred in a square frame with the whole head visible, looking at the camera. A distinguished South Asian gentleman in his late 60s with swept-back silver hair, white handlebar moustache, red bow tie, camel blazer, warm knowing smile. Glossy expressive eyes with catchlights, soft subsurface skin, warm key light from the upper left, cool blue rim light on the right edge. Plain deep indigo-violet studio background with a soft glow behind the head. No text, no border, no watermark, no hands.
```

## Putting them in the app (from a phone)

1. Save each image with the file name shown above (`lady.png`, `auntie.png`, …). JPG or WebP is fine too.
2. In Safari open github.com/ameerthadani2/Mah-jong-Madness, switch to branch `claude/p2p-taiwanese-mahjong-app-9lzdls`, and go to `apps/mobile/assets/avatars/`. If you don't see **Add file**, tap **aA → Request Desktop Website**.
3. **Add file → Upload files**, pick the images, **Commit changes**.
4. The **Import avatar art** workflow crops each image to a square, shrinks it to 384×384, switches the app to use it, then rebuilds the web preview and the Expo Go update. Characters you haven't uploaded keep their drawn portrait, so you can upload one at a time.

Upload a better version any time by uploading a file with the same name.
