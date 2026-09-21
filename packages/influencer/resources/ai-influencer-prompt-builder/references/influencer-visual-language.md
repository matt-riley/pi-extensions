# Influencer Visual Language Reference

## Why AI influencers read as fake

The tell is almost never the face shape — modern models nail bone structure. It's **texture and light**. Real skin scatters light unevenly; real cameras have artifacts; real people are shot by other real people holding a phone at a slightly wrong angle. Renders fail on:

- Skin that's uniformly smooth with no pore texture or micro-variation
- Symmetric, evenly-lit faces with no directional shadow
- Hair that reads as a single sculpted mass instead of individual strands/flyaways
- Eyes with a single flat catchlight instead of the way skin, light source, and environment actually interact
- Backgrounds and outfits that look art-directed rather than lived-in
- Compositions that feel like commercial photography rather than "someone's friend took this"

Fixing the prompt at the texture and camera level does more than fixing it at the "make the face more realistic" level.

---

## Imperfection markers (the anti-tell toolkit)

Include 2–3 of these in every foundational prompt. Rotate which ones you use per character so characters don't all share the same "realism trick."

**Skin:**
- Visible pore texture, especially on the nose and forehead
- Faint under-eye texture or very slight darkness (not airbrushed flat)
- Subtle asymmetry — one brow slightly higher, a faint smile-line difference side to side
- A small number of visible skin details: a freckle, a faint old scar, a tiny mole — placed specifically, not scattered randomly
- Slight sheen/shine on the T-zone rather than uniform matte

**Hair:**
- Flyaway strands, especially near the hairline
- Slight frizz or texture rather than a perfectly sculpted silhouette
- Natural part imperfection — not razor-straight

**Eyes:**
- Catchlight shaped by the actual light source described in the prompt (window, ring light, sun) rather than a generic dot
- Slight redness or texture in the sclera, not pure white
- Natural, slightly uneven lash density

**Composition:**
- Very slight handheld tilt or off-center framing (a couple of degrees, not dramatic)
- Slight motion blur at the edges if mid-movement
- Natural background clutter appropriate to the setting — nothing sterile

**Wording pattern:** describe these as observed detail, not as instructions to add flaws — e.g. *"faint freckle cluster across the nose bridge, a few flyaway hairs at the temple, natural asymmetry with the left brow set slightly higher"* rather than *"imperfect skin, messy hair."*

---

## Lighting language for influencer content

Influencer photography is shot by influencers, not by lighting departments. Match the lighting to the platform-native shooting style, not generic studio setups.

**Selfie / front-camera:**
- Front-facing phone camera light — soft, slightly flat, closer to the face
- Ring light catchlight — small circular reflection in the eyes, common in beauty/makeup content
- Window light selfie — soft directional light from one side, common in lifestyle/GRWM content

**Mirror selfie:**
- Bathroom or bedroom ambient light mixed with a visible phone flash or screen glow
- Slight underexposure balanced by a bright flash on the subject

**Outdoor / lifestyle:**
- Golden hour backlighting, slight lens flare, warm skin tones
- Overcast diffused daylight — flattering, low-contrast, common in travel and wellness content
- Harsh midday sun with a slight squint — common in candid, unposed-feeling street content

**UGC / candid:**
- Available light only, slightly underexposed or overexposed like a real phone photo
- Indoor tungsten mixed lighting with a slight warm color cast, uncorrected white balance

**Studio-adjacent (beauty/fashion niches only):**
- Softbox beauty lighting, but slightly less perfect than commercial — one side marginally brighter
- Practical lamp + window fill, common in "get ready with me" content

Avoid generic "three-point studio lighting, evenly lit" language unless the niche is explicitly high-fashion or beauty-commercial — it's the fastest way to make a character look like a render instead of a creator.

---

## Camera & angle language native to influencer platforms

Influencer content has its own camera grammar, distinct from cinematic or product photography.

**Devices (each has a visual signature):**
- iPhone front camera — slightly wide, soft compression, natural skin rendering
- iPhone rear camera, portrait mode — shallow depth of field with occasional edge-detection softness around hair
- Point-and-shoot / disposable-style — flash-lit, slight grain, nostalgic (common in Gen Z "film" aesthetic content)
- DSLR with 50mm — used for more polished creator photography (beauty, fashion)

**Angles:**
- Slightly elevated selfie angle (the classic influencer angle — camera above eye line, chin slightly down)
- Straight-on mirror selfie
- Low, close hand-held angle for "candid caught on camera" energy
- Over-the-shoulder or POV for GRWM and tutorial-style content
- Eye-level, arm's-length — the default for casual talking-to-camera content

**Framing:**
- Close, intimate framing with the subject filling most of the frame — typical of beauty/skincare content
- Medium shot with visible environment — typical of lifestyle/fashion content
- Slightly imperfect crop, as if unplanned, rather than perfectly centered

---

## Niche-by-niche visual codes

| Niche | Lighting | Camera style | Styling cues |
|---|---|---|---|
| **Fitness** | Harsh gym fluorescents or bright outdoor daylight | Mirror selfie or tripod wide shot | Athletic wear, visible sweat sheen, minimal makeup, high energy |
| **Beauty / skincare** | Ring light or soft window light, close framing | Front camera, close-up | Flawless-but-textured skin, styled brows, product visibly in frame |
| **Lifestyle / travel** | Golden hour or overcast daylight | Candid, slightly off-center, environmental | Relaxed styling, layered outfits, background does narrative work |
| **Tech / AI** | Cool desk lamp or monitor glow, moody | Webcam or tripod medium shot | Minimal, neutral styling, clean but not sterile background |
| **Comedy / entertainment** | Flat, bright, slightly overexposed | Handheld, close, expressive | Exaggerated expression, bold color, high contrast styling |
| **Fashion** | Directional studio or street daylight | Full-body, editorial angles | Statement outfit, deliberate pose, more polish than other niches |
| **Wellness / cottagecore** | Soft natural light, warm and diffused | Static or slow handheld | Muted natural tones, textured fabrics, calm expression |

Use this table as a starting point, not a cage — a "wellness tech founder" niche should blend rows.

---

## Consistency anchoring

Regeneration drifts fastest on: exact eye color/shape, exact quirk placement, exact skin tone, and hairline. To hold a character stable across dozens of future generations:

1. **Give the quirk a fixed, specific location.** "A faint scar" drifts. "A faint half-inch scar through the left eyebrow" doesn't.
2. **Anchor eye color and shape with a comparison.** "Warm hazel eyes, slightly almond-shaped, hooded lid" is more stable than "brown eyes."
3. **Fix the skin tone with an undertone description**, not just a shade — "medium-deep brown skin with warm golden undertones."
4. **Name the hairline and part.** "Deep side part, natural widow's peak" holds better across generations than no mention at all.
5. **Repeat the Consistency Anchors block verbatim** in every future prompt for that character — don't paraphrase it generation to generation, even slight rewording compounds drift over many images.
6. **Add silhouette anchors for non-front views.** Name hair length and texture, how it falls at the nape, body build, posture, and any mark visible from the side or back.

---

## Annotated example

**Inputs:** Age 27, female, mixed Black and Southeast Asian, wellness/mindfulness niche, defining quirk: a small nose stud and a gap between her front teeth.

```
[Core Identity] A 27-year-old woman of mixed Black and Southeast Asian
 descent, warm medium-brown skin with golden undertones.
[Face & Features] Almond-shaped dark brown eyes with a soft hooded lid,
 high cheekbones, a straight nose bridge, full lips, a naturally defined
 jaw. Deep side part in loosely curled dark brown hair, natural
 widow's peak.
[Defining Quirk] A small gold nose stud on the left nostril, and a
 noticeable gap between her two front teeth, visible when she smiles.
[Skin & Imperfection Realism] Visible pore texture at the nose and
 forehead, a faint freckle cluster across the cheekbones, slight
 natural asymmetry with the left brow set marginally higher, a few
 flyaway hairs at the temple.
[Niche-Coded Styling] Loose linen top in a muted sage tone, minimal gold
 jewelry, soft natural makeup with a slight sheen on the cheeks.
[Lighting] Soft overcast daylight through a window, diffused and warm,
 no harsh shadow.
[Camera & Angle] Shot on an iPhone rear camera in portrait mode,
 slightly elevated eye-level angle, shallow depth of field with soft
 background blur.
[Setting] Seated on a linen-covered daybed near a large window, out-of-
 focus houseplants in the background.
[Style Signature] Natural, slightly warm color grading, soft grain,
 unposed candid energy — shot like a friend took it, not a studio.
```

**Consistency Anchors:**
- Almond-shaped dark brown eyes, soft hooded lid, high cheekbones
- Gold nose stud on left nostril + visible gap between front teeth when smiling
- Medium-brown skin, golden undertones, freckle cluster across cheekbones
- Deep side part, natural widow's peak, loosely curled dark brown hair
