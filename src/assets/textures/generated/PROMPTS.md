# Generated texture atlas prompts

These six project-bound atlases were produced with the built-in OpenAI image-generation tool.
Every prompt requested an exact 3-column by 2-row, 1536×1024 atlas. At runtime, the game slices
the 512×512 cells, closes opposite seams, and maps them to the named material recipes.

## Tartarus atlas

```text
Use case: stylized-concept
Asset type: 3-by-2 game texture atlas, six seamless hand-painted albedo textures
Primary request: Create one exact 3-column by 2-row atlas for EREBUS — Descent's Tartarus biome. Each cell is an edge-to-edge square material swatch with no gutter, no frame, no label, no lighting hotspot, and no perspective. Top row left-to-right: (1) irregular warm crimson stone ashlar floor, broad worn slabs with ink-dark plum joints; (2) blood-red carved underworld wall stone with sparse chisel scars and violet crevices; (3) broken crimson rubble and cracked flagstone chips, dense but evenly distributed. Bottom row left-to-right: (4) aged warm ivory bone, subtle pores and fine cracks; (5) dark arterial crimson blood/ichor surface with restrained glossy currents; (6) heavy woven crimson banner cloth with diagonal brush fibers and darker folded dye variation.
Style/medium: painterly mythic action-game texture, clearly hand-painted directional brushwork, saturated jewel tones, hard ink-colored crevices, selective hand-placed highlights; not photographic and not flat vector art.
Composition/framing: orthographic flat texture atlas, exact 3:2 overall aspect, exact equal square cells, crisp cell boundaries, each cell fully filled, textures designed to tile seamlessly on all four edges.
Color palette: #07060f, #120b1e, #241238, #3a1d52, #ff5a3c, #8c3b46, #5a2331, #2c1020, #c81d3c, bone #efe3cf.
Materials/textures: deliberate directional strokes, value variation within each material, darkened crevices, hand-painted highlights, consistent texel density.
Constraints: no text, no symbols, no UI, no border, no separator lines, no watermark, no logos, no objects casting shadows, no single focal object. Keep every tile edge-to-edge and seamless; preserve an exact 3 columns by 2 rows layout.
Avoid: photoreal grunge, generic noise, muddy brown, neutral gray shadows, visible repetition, perspective, vignette, scene lighting.
```

## Tartarus materials v2 atlas

Image 1 was the live-game screenshot supplied as a visual reference for palette, materials, and
on-screen texel scale only; the generated deliverable is a new flat material atlas, not an edit.

```text
Use case: stylized-concept
Asset type: exact 3-column by 2-row game texture atlas containing six seamless square albedo textures
Input images: Image 1 is a visual reference for the current Tartarus game scene, palette, materials, and on-screen scale only; do not recreate the scene.
Primary request: Generate a darker, richer second-pass Tartarus material atlas that adds clearly readable surface texture without the fluorescent orange/purple clipping visible in earlier versions.
Composition/framing: one exact 3:2 landscape atlas, three equal square cells across and two equal square cells down, crisp cell boundaries, no gutters, no frames, no labels, each cell filled edge-to-edge and designed to tile seamlessly on all four edges.
Top row left-to-right:
1. ancient near-black oxblood flagstone floor, irregular Greek masonry joints, broad worn brush variation, sparse dried-ichor staining, restrained plum undertones;
2. carved dark bloodstone architecture, deep chisel cuts, shallow Greek meander and palmette relief distributed evenly, charcoal-crimson faces and muted violet recesses;
3. weathered underworld guardian-statue stone surface only, smoky black marble with fine age cracks, rubbed edges and sparse dull bronze mineral veins, no creature or sculpture.
Bottom row left-to-right:
4. blackened hammered bronze brazier metal, soot-dark body, small worn-gold edge flecks, subtle old verdigris collected in pits;
5. charred ancient timber, long hand-adzed grain, split fibers, deep umber-black and plum shadows, restrained warm worn ridges;
6. Tartarus rubble stone, broken crimson-black aggregate, chipped planes, bone dust and dark mortar, evenly distributed with no focal rock.
Style/medium: hand-painted mythic action-game texture, confident directional brushwork, readable at an isometric gameplay camera, tactile material separation, rich dark values with selective midtone detail; not photographic and not flat vector art.
Lighting/mood: neutral material reference lighting only; no baked spotlight, no glow, no volumetric rays, no vignette.
Color palette: ink black #08070d, charcoal plum #18121f, muted oxblood #4b202a, dark crimson #6d2935, restrained bronze #8d6936, worn gold #c8a45c, subtle verdigris #3f746c.
Constraints: surfaces only; exact 3-by-2 grid; every cell is a square; seamless edges; no text, no UI, no border, no separator line, no watermark, no logos, no isolated objects, no cast shadows, no scene perspective, no bright orange fields, no electric violet fields.
Avoid: fluorescent colors, near-white highlights, generic noisy grunge, obvious repetition, perspective, baked directional lighting, large motifs, characters, statues, braziers, logs, or rubble objects—the cells must remain flat material swatches.
```

## Asphodel and Elysium atlas

```text
Use case: stylized-concept
Asset type: 3-by-2 game texture atlas, six seamless hand-painted albedo textures
Primary request: Create one exact 3-column by 2-row atlas for EREBUS — Descent's Asphodel and Elysium biomes. Each cell is an edge-to-edge square material swatch with no gutter, frame, label, lighting hotspot, or perspective. Top row left-to-right: (1) midnight-violet obsidian basalt wall, fractured large plates with teal edge glints; (2) charred black volcanic flagstone floor, irregular worn slabs with ember-red hairline seams; (3) molten lava surface, pale gold-white cores through saturated orange and deep crimson currents. Bottom row left-to-right: (4) ancient warm ivory Greek marble with broad lavender-gray veins and hand-brushed wear; (5) Elysium floor of pale marble tiles with restrained green laurel inlay and thin worn gold geometry; (6) river Styx water, near-black indigo surface with long cyan-violet painted ripples.
Style/medium: painterly mythic action-game texture, hand-painted directional brushwork, saturated jewel tones, ink-dark colored crevices, selective sharp painted highlights; not photographic and not flat vector art.
Composition/framing: orthographic flat texture atlas, exact 3:2 overall aspect, exact equal square cells, crisp cell boundaries, each cell fully filled, textures designed to tile seamlessly on all four edges.
Color palette: ink #07060f #120b1e #241238 #3a1d52; Asphodel #fff0b0 #ff8c1a #c22a06 #2a2740 #0d0b18 #33e0c0; Elysium #efe3cf #8a7f9c #3fa86a #14402f #ff5fa8; worn gold #c98f2b.
Constraints: no text, no UI, no border, no separator lines, no watermark, no logos, no isolated objects, no cast shadows, no focal object. Keep every tile edge-to-edge and seamless; preserve exact 3 columns by 2 rows.
Avoid: photoreal grunge, generic noise, muddy brown, neutral gray shadows, obvious tiling, perspective, vignette, scene lighting.
```

## Metals and props atlas

```text
Use case: stylized-concept
Asset type: 3-by-2 game texture atlas, six seamless hand-painted albedo textures
Primary request: Create one exact 3-column by 2-row atlas for EREBUS — Descent's crafted materials. Each cell is an edge-to-edge square material swatch with no gutter, frame, label, lighting hotspot, or perspective. Top row left-to-right: (1) ornate molten-gold Greek filigree relief on ink-plum recesses, meander and palmette motifs distributed evenly; (2) worn hammered gold leaf, overlapping flakes and brush-polished highlights; (3) aged bronze plate with turquoise verdigris gathered in carved channels. Bottom row left-to-right: (4) dark forged iron, blue-black directional hammer marks and sparse warm edge wear; (5) charred dark olive-brown wood, long straight grain and hand-adzed grooves; (6) violet underworld crystal surface, angular facets in deep plum with saturated lavender and cyan inner glow.
Style/medium: painterly mythic action-game texture, hand-painted directional brushwork, saturated jewel tones, ink-dark colored recesses, deliberate highlight strokes; not photographic and not flat vector art.
Composition/framing: orthographic flat texture atlas, exact 3:2 overall aspect, exact equal square cells, crisp cell boundaries, every cell fully filled, textures designed to tile seamlessly on all four edges.
Color palette: ink #07060f #120b1e #241238 #3a1d52; gold #ffe9a8 #f2c14e #c98f2b #6d4416; verdigris #3f8f7a; iron blue-black; violet crystal #a05fe0 #c9b8ff #5fd0ff.
Constraints: no text, no UI, no border, no separator lines, no watermark, no logos, no isolated objects, no cast shadows, no focal object. Keep every tile edge-to-edge and seamless; preserve exact 3 columns by 2 rows.
Avoid: photoreal grunge, generic noise, muddy neutral metal, chrome mirror finish, obvious tiling, perspective, vignette, scene lighting.
```

## Character materials atlas

```text
Use case: stylized-concept
Asset type: 3-by-2 game character-material texture atlas, six seamless hand-painted albedo textures
Primary request: Create one exact 3-column by 2-row atlas for EREBUS — Descent character surfaces. Each cell is an edge-to-edge square material swatch with no gutter, frame, label, lighting hotspot, or perspective. Top row left-to-right: (1) stylized warm Mediterranean hero skin tone texture with subtle broad painterly value variation, no body features; (2) heavy underworld cloth woven in deep plum and crimson, visible directional fibers and worn ridges; (3) near-black hair and leather surface with long indigo brush strands and sparse warm edge wear. Bottom row left-to-right: (4) ornate hammered bronze armor with dark plum chased channels and warm gold edge glints; (5) scarred heavy round-shield bronze face texture with centered-but-repeating Greek radial engraving, dark oxidized recesses; (6) heroic off-white linen fabric with crimson woven trim fragments and fine gold thread, evenly distributed rather than forming a garment.
Style/medium: painterly mythic action-game character texture, broad confident brushwork, saturated jewel-tone shadows, ink-dark colored crevices, selective hand-placed highlights, simplified enough to read on small animated characters; not photographic.
Composition/framing: orthographic flat texture atlas, exact 3:2 overall aspect, exact equal square cells, crisp cell boundaries, each cell fully filled, textures designed to tile seamlessly on all four edges.
Color palette: ink #07060f #120b1e #241238 #3a1d52; crimson #8c3b46 #c81d3c; warm skin; bronze/gold #ffe9a8 #f2c14e #c98f2b #6d4416; linen #efe3cf.
Constraints: surfaces only—no faces, eyes, hair silhouettes, hands, bodies, garments, weapons, characters, text, UI, border, separator lines, watermark, logos, cast shadows. Keep every tile edge-to-edge and seamless; preserve exact 3 columns by 2 rows.
Avoid: photoreal skin pores, body parts, cloth folds forming clothing, generic noise, muddy brown, neutral gray shadows, perspective, vignette, scene lighting.
```

## Creatures and props v3 atlas

Image 1 was the live-game screenshot supplied as a visual reference for palette, materials, and
on-screen texel scale only; the generated deliverable is a new flat material atlas, not an edit.

```text
Use case: stylized-concept
Asset type: exact 3-column by 2-row game texture atlas containing six seamless square albedo textures.
Input images: Image 1 is a visual reference for the current live Tartarus scene, its dark oxblood/blackened-bronze palette, painterly material language, and isometric gameplay texel scale only. Do not recreate or edit the scene.
Primary request: Generate a focused third-pass texture atlas that upgrades the Ember Hound enemies and the weakest Tartarus props while remaining dark, tactile, and non-emissive.
Composition/framing: one exact 3:2 landscape atlas, three equal square cells across and two equal square cells down, crisp cell boundaries, no gutters, no frames, no labels, every cell filled edge-to-edge and designed to tile seamlessly on all four edges.
Top row left-to-right:
1. Ember Hound body hide: short coarse oxblood-black fur over scarred leathery skin, broad directional brush clumps, charcoal recesses, restrained burnt-crimson ridges, no glow;
2. Ember Hound lower-limb hide: near-black soot fur with long downward strands, worn dark-red hock patches, subtle dusty paws, no body parts or silhouette;
3. Ember Hound horn and spine keratin: layered smoky-black horn grain with aged ivory edge wear and sparse muted bronze cracks, no isolated horns.
Bottom row left-to-right:
4. Tartarus amphora and censer ceramic: dark fired clay with uneven hand-painted oxblood slip, fine crazing, soot in pores, sparse worn geometric brush marks distributed evenly;
5. Tartarus blackened forged iron: blue-black hammer marks, deep plum oxidation, tiny restrained rusty edge wear, extremely low reflectance, no bright metal;
6. Tartarus ancient timber: charred umber-black hand-adzed grain, split fibers, old crimson resin staining, muted worn ridges.
Style/medium: premium hand-painted mythic action-game material art, confident directional brushwork, readable at an isometric gameplay camera, simplified macro detail with tactile micro detail, rich dark values and selective muted midtone accents; not photographic, not flat vector.
Lighting/mood: neutral material reference lighting only, even exposure; no baked spotlight, no glow, no flame, no volumetric rays, no vignette.
Color palette: ink black #08070d, charcoal plum #18121f, deep oxblood #4b202a, dark crimson #6d2935, soot brown #2b1b1b, muted ivory #b9aa8e, restrained bronze #79613a, subtle cold iron #26313b.
Constraints: flat material surfaces only; exact 3-by-2 grid; every cell square; seamless edges; no text, UI, border, separator line, watermark, logos, isolated objects, cast shadows, scene perspective, characters, dogs, body parts, amphora objects, chains, logs, bright orange fields, electric violet fields, or near-white highlights.
Avoid: fluorescent color, generic noisy grunge, obvious repetition, perspective, baked directional lighting, large focal motifs, glossy plastic, emissive edges.
```
