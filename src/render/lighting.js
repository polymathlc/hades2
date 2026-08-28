// OWNER: AGENT-RENDER — the light rig (ART_DIRECTION §3).
//
//   key        one strong directional per chamber, biome-tinted, tight shadow frustum
//   fill       low hemisphere tinted with the biome's shadow colour; never lifts the
//              blacks above ~0.06 luminance
//   rim        an ART-DIRECTED CONSTANT, not a real light. Published as a shared
//              uniform block for the material system to consume — we set it, we do
//              not reimplement painterly rim shading here.
//   bounce     a wide, very dim area light from the floor, tinted with the floor albedo
//   practicals a pool of point lights (braziers / lava / glyphs) flickering on
//              SMOOTHED NOISE — never a sine wave
//
// It also owns Atmosphere (main.js has no slot for it), and drives its lifecycle.
import * as THREE from 'three';
import { Atmosphere } from './atmosphere.js';
import { GRADES, DEFAULT_BIOME } from './shaders/grades.js';

// ── smoothed value-noise flicker (deterministic, seeded from ctx.rng) ────────
class Flicker {
  constructor(rng, n = 96){
    this.v = new Float32Array(n);
    for(let i = 0; i < n; i++) this.v[i] = rng ? rng.f() : 0.5;
    this.n = n;
  }
  _at(x){
    const n = this.n;
    const i = Math.floor(x), f = x - i;
    const u = f * f * f * (f * (f * 6 - 15) + 10);      // smootherstep
    const a = this.v[((i % n) + n) % n];
    const b = this.v[(((i + 1) % n) + n) % n];
    return a + (b - a) * u;
  }
  /** two incommensurate octaves: a slow breathe plus a fast guttering */
  value(t, speed = 1){
    const slow = this._at(t * 0.9 * speed);
    const fast = this._at(t * 4.7 * speed + 31.7);
    const fizz = this._at(t * 13.3 * speed + 71.3);
    return slow * 0.55 + fast * 0.30 + fizz * 0.15;
  }
}

// ── authored rigs ───────────────────────────────────────────────────────────
// NOTE ON RIM DIRECTION (§1.2, "non-negotiable"):
// the shading gate is dot(worldNormal, uRimDir), so the rim lands on surfaces
// whose normal points ALONG uRimDir. The shipping camera sits at yaw 45deg on
// the +X/+Z side, so any rim direction with a negative Z component fires on the
// far side of every object and is invisible from the play camera — which is
// exactly why the mandated #5fd0ff edge did not appear in a single frame. The Z
// term must be POSITIVE: up, camera-left, and toward the lens.
// dir = the direction the key light TRAVELS (from the source into the scene).
const RIGS = {
  tartarus: {
    // §1.1 three-band value structure: the fill is a WHISPER. Everything the
    // frame reads as "lit" comes from the key or a practical, so the ground
    // plane can sit at 0.15-0.20 luma and a character burns out of it.
    //
    // KEY ELEVATION. The old dir sat at 40deg, which on this azimuth threw every
    // column / brazier / pier shadow straight AWAY from the 45deg play camera —
    // i.e. behind the object that cast it. 25deg roughly doubles the shadow
    // length and sweeps it across camera-visible floor, which is the only thing
    // that stops the ground plane reading as one unmodulated slab.
    // 25deg buys long cast shadows but the 132-340deg perimeter arc then
    // shadows most of the arena from this azimuth. 32deg keeps roughly 1.6x the
    // old shadow length while letting the key back on to the ground plane.
    // §2 puts the Tartarus key at #ff5a3c (HSV sat 0.76). It had been bleached
    // to #ffb894 (sat 0.42) purely to stop an over-exposed rig from clipping,
    // which removed the biome's identity from every lit surface in the game.
    // #ff7a52 is sat 0.68 and it survives the corrected exposure intact.
    // INTENSITY: the whole rig is authored 2.42x hotter than it was, because
    // grades.js no longer carries a 2.90 exposure to compensate for it. The
    // extra 1.6x on top is the luminance the saturated key gives back.
    // §9 THE VALUE LAW. The rig used to be authored so that the FLOOR read as
    // lit — key 52 x NdotL 0.545 on a 100%-up-facing plane was the single
    // largest irradiance in the frame, and the measured result was a salmon
    // ground plane 62% brighter than the frame median. The floor is now cut at
    // the MATERIAL (floor.tartarus litGain/ambGain in materials/library.js), so
    // the key can stay strong for the architecture without ever painting the
    // stage. Everything below is authored around that split.
    //
    // KEY. Lowered from 52 because the ground-plane cut no longer has to be
    // paid for by the whole rig, and raised in elevation from -0.545 to -0.615:
    // the 32deg sun threw column shadows two-thirds of the way across the arena
    // as huge soft lozenges (§9.7 "stains, not shadows"). At 38deg they are
    // still long enough to describe the form and short enough to read as cast
    // shapes with an end.
        // §2 puts the Tartarus key at #ff5a3c. #ff8a58 was a bleached compromise
    // and it is what made every lit stone in the chamber read SALMON — one hue
    // family across the whole frame (§9.6). #ff7048 is most of the way back to
    // the authored crimson; the intensity is raised to hold the same luminance
    // (a saturated key delivers ~0.83x the luma of a pale one at equal power,
    // and materials/library.js _keyRef() tracks that automatically).
    // INTENSITY (integration pass): 38 put every lit stone face 2+ stops over
    // middle grey, and AgX bleaches saturated colour as it approaches the
    // shoulder — which is why a #8c3b46 crimson wall and a #f2c14e gold capital
    // and a #e8bd93 face all arrived at the display as the SAME pale salmon.
    // That is §9.6's "monochrome mud", and it is not fixable downstream: once
    // the transform has desaturated a value there is no hue left to grade back.
    // At 26 the same surfaces land in AgX's linear-ish midrange, the stone
    // reads crimson, the gold reads gold, and measured meanSaturation goes
    // 0.688 -> 0.739 while groundP90 drops 0.356 -> 0.215.
    // SUBJECT PASS. At 26.0 the hero's key-side planes measured [254,154,135]
    // — red pinned at the clip point across the whole lit half of the body, so
    // there was no cheekbone, no brow ridge and no cloth fold anywhere on the
    // character: one flat blown salmon plane. 15.5 puts the same planes at
    // ~200-215 where AgX still has a gradient to spend on form. The hero does
    // NOT get darker overall, because the light it loses here is given back
    // LOCALLY by `subject` below — which is the whole point: light the subject,
    // not the frame. NOTE the coupling — materials/library.js _keyRef() tracks
    // key intensity x key luminance, and painterly.js anchors BOTH the shading
    // ramp and the rim energy to it, so this also takes ~40% off every rim in
    // the chamber for free.
    // A heavily saturated key paints every surface its own hue and overrides the albedo the
    // material system worked to author, which is why the room read as one orange. Pulling the key
    // toward a warm near-white lets each material show ITS colour and leaves hue variety to the
    // coloured practicals — the opposite of raising global saturation, which only amplifies
    // whatever single hue already dominates. See ART_DIRECTION §15.
    key:    { color: '#ffc9a8', intensity: 16.5, dir: [0.646, -0.615, -0.452] },
    // ── THE SUBJECT LIGHT (§1.1, §9.2) ──────────────────────────────────────
    // The frame did not know who its subject was. Every light in this rig was
    // authored for the ROOM — a key for the architecture, practicals nailed to
    // the perimeter walls — and the character was lit only incidentally, by
    // whatever the room happened to spill on it. Measured result: background
    // braziers at 0.69 display median against a hero at 0.35, i.e. the props
    // BEHIND the player out-valued the player by 2x while sitting on the top
    // and side edges of frame. That is a centrifugal composition and no amount
    // of grading fixes it.
    //
    // This is a small, warm, tightly-falling-off point light carried by the
    // hero. It is not a real source in the fiction (nothing in the chamber
    // casts it) — it is the art-directed subject key, the same device a Hades
    // frame uses to keep Zagreus the brightest coherent shape in the play area
    // no matter what room he is standing in.
    //
    // WHY IT DOES NOT PAINT THE FLOOR. Two reasons, both structural:
    //   1. inverse-square. At `distance` 6.0 / decay 2 the hero's torso sits
    //      ~0.5u from the source and the floor under him ~2.0u, so the floor
    //      receives ~1/16 of what the body does. It dies inside the character's
    //      own footprint.
    //   2. floor.tartarus is authored litGain 0.22 in materials/recipes.js, so
    //      the fraction that does reach the stage arrives at a fifth strength.
    //   Between them the light lands almost entirely on the standing form.
    // OFFSET is camera-side (+X/+Z at the fixed 45deg play yaw) and raised, so
    // it models the hero from the lens with a real terminator down the body
    // instead of flattening it with a frontal fill.
    // COLOUR IS A CLIPPING CONTROL. The hero's lit planes pin RED first under a
    // saturated warm source — [254,154,135] is not a bright pixel, it is a dead
    // channel, and a dead channel has stopped carrying form. A paler subject key
    // delivers the same luminance with the red channel ~15% lower, so the lit
    // side keeps a gradient instead of a plateau. Target: no hero pixel over 244.
    subject: { color: '#ffe2c8', intensity: 16.0, distance: 6.6, decay: 2.0,
               offset: [0.80, 1.95, 1.20] },
    // §3: "fill ... never lifts blacks above ~0.06 luminance". At 2.60 with a
    // saturated periwinkle sky this was the brightest thing landing on the
    // floor after the key, and it is what turned every cast shadow into a
    // lilac stain instead of an ink shape. The fill is now a WHISPER in the
    // authored plum, and the cool note in the frame is carried by the RIM and
    // by real cyan practicals instead of by a wash.
    // GROUND COLOUR IS THE UNDERCUT LIGHT. A hemisphere gives a DOWN-facing
    // normal its groundColor and an UP-facing one its skyColor, so this term is
    // the only light in the rig that lands on soffits, cornice undersides,
    // meander channels, bead undercuts and the shadowed side of every carved
    // arris — and none of it reaches the floor, which faces up and takes `sky`.
    // At #170d26 (linear 0.0075/0.0040/0.0189) an undercut received effectively
    // nothing, so relief rendered as light-on-black STENCIL LINE-ART: a lit
    // arris with a hole beside it instead of a channel with a floor. §1.3 says
    // a shadow is a different COLOUR, not an absence, and §2 names the colour —
    // this is #241238 (deep shadow / shadow plum) pushed a little toward
    // #3a1d52 so a channel has a violet interior a critic can see into.
    // It is a 5x lift on a very small number and it is spent entirely on
    // down-facing geometry: the floor plane does not move at all.
    hemi:   { sky: '#31336e', ground: '#2c1644', intensity: 0.75 },
    // A tight warm pool that grazes the standing forms near the centre — the
    // §3 fake bounce, not a lift.
    bounce: { color: '#8a3a34', intensity: 0.40, size: [11, 11], y: 1.6 },
    // THE FLOOR BOUNCE IS THE ONLY BROAD LIGHT THAT CANNOT TOUCH THE FLOOR.
    // A RectAreaLight is single-sided: this plate lies ON the stage facing UP,
    // so the ground plane is coplanar with it and receives literally nothing
    // (N.L = 0, and it is behind the emitting face), while every VERTICAL
    // surface in the room — column shafts, wall dado, plinths, the statuary —
    // sits in its solid angle. That is exactly the §11.3/§9.1 split the value
    // law asks for: lift the standing forms, leave the stage dark. At 0.12 it
    // was doing nothing at all; 0.52 gives the mid-ground's lower half the
    // bounce a real stone floor would throw and stops the wall reading as a
    // black band under the washed cornice. Tinted with the FLOOR's own crimson
    // (§3 "tinted with the floor albedo") so it recedes toward the ink ramp
    // rather than greying anything.
    bounce2:{ color: '#5a2430', intensity: 0.52, size: [34, 34], y: 0.12 },
    // §1.2 non-negotiable, and §9.6 wants the complement genuinely VISIBLE.
    // The rim is now the second-strongest light in the frame by design: it is
    // what draws every vertical edge in the chamber.
    // §1.2 SCOPES THE ART-DIRECTED RIM TO CHARACTERS. This constant is
    // published to EVERY painted material in the chamber, and at 9.2 / power
    // 1.30 / wrap 0.55 — four times the intensity and nearly twice the wrap of
    // the Asphodel (2.4 / 2.2 / 0.34) and Elysium (2.2 / 2.3 / 0.30) rigs — the
    // result was that every wall, rubble chunk, statue, plinth and column
    // carried the same pale halo the hero did. When everything is rimmed,
    // nothing is separated from anything: measured character-to-world rim gap
    // was 1.25x. materials/library.js _applyRim() maps this through
    // clamp(intensity/2.4) and SKIPS any material that authored its own rim, so
    // the hero (entities/rig.js SLOT_PAINT, rimStrength 9.8-13.2) keeps its
    // edge at full while the world drops to a hairline. Power 2.6 narrows the
    // fresnel band from a washed face to a drawn arris.
    // THE COLOUR PUBLISHED HERE IS A PRE-IMAGE, NOT THE PALETTE VALUE.
    // materials/painterly.js multiplies whatever it is given by
    // vec3(0.30, 1.22, 0.72) as a pre-compensation for AgX's inset (which
    // rotates saturated blue toward violet and bleaches it toward white).
    // Publishing §2's literal '#5fd0ff' through that multiply lands the world's
    // and the enemy roster's rim at hue ~176 — a green-cyan — while the hero,
    // whose entities/rig.js authors the pre-image '#8fa4ff', lands at hue 198.
    // Two different hues, both claiming to be the one mandated accent, is
    // exactly the "the complement never arrives" failure §9.6 keeps reporting.
    // #8fa4ff * (0.30,1.22,0.72) = linear (0.082, 0.453, 0.720) -> display
    // rgb(79,179,222), hue 198, sat 0.68 = §2's Tartarus rim/accent EXACTLY.
    // So the rig publishes the pre-image and the whole chamber agrees with the
    // hero. When painterly.js ships `vec3 rimC = uRimColor;` this goes back to
    // '#5fd0ff' and rig.js's RIM_HEX goes with it — the two must move together.
    rim:    { color: '#8fa4ff', dir: [-0.62, 0.36, 0.70], intensity: 2.8, power: 2.60, wrap: 0.22 },
    ambient:{ color: '#241238', intensity: 0.34 },
    godrayAnchor: [0.22, 1.06],
    // §9.3 + §9.5. With the bloom fog gone, bands.highlight measured 0.021
    // against a 0.04 floor — the frame's old top band was NOT ornament, it was
    // halo, and removing the halo exposed that there was nothing underneath it.
    // The honest source of a highlight band is a small, sharp SPECULAR hit on
    // metal, so keyGain goes 20 -> 34: more energy into the tight keySharp 200
    // lobe that gold filigree, bronze and the brazier rims reflect, and none of
    // it into the floor's diffuse.
    // §9.5 "ornament carries the light": keyGain drives the sharp specular lobe
    // the gold filigree, the bronze and the brazier rims reflect, and it is the
    // cheapest route to a real highlight band that is NOT a lit floor.
    env:    { zenith: '#150e30', horizon: '#33183e', nadir: '#140916', keyGain: 34.0, keySharp: 200, keyWide: 0.05, rimGain: 2.0, rimSharp: 22, bounce: '#8c2f26', bounceGain: 0.03, intensity: 0.55 },
    // §9.5 + §9.6. Two families:
    //   WARM  tight brazier pools, radius ~8.5, sitting ON the ornament ring so
    //         the light lands on the annulus of floor the glaze paints bright
    //         and dies before it reaches the near apron (§9.1).
    //   COOL  #5fd0ff wall / capital washes. These are the ones that put the
    //         mid-ground architecture a full value band ABOVE the ground plane
    //         and carry the mandated complement into the frame at scale.
    practicals: [
      // WARM braziers on the arc theta 132-316deg. They are deliberately spread
      // from dep 0.13 to dep 0.52 and NONE of them sits in the foreground apron
      // (dep > 0.60): §1.8 + §9.1 want the near half of the arena to be a dark
      // repoussoir, and a brazier standing in it lights exactly the band the
      // value law needs black. Spreading them this wide also stops the arena
      // from developing an unlit gap between the brazier arc and the apron,
      // which is what collapsed the wide shot's mid band into its near band.
      // chamber.js reads these positions to place the brazier GEOMETRY, so the
      // props follow the lights automatically — move one and the prop moves.
      // §9.2 / §1.1 SUBJECT PASS. These sat at 200/175 and measured 0.64-0.69
      // display median on the brazier props themselves, against a hero at 0.35
      // — the furniture BEHIND the player was twice the value of the player,
      // and RIGS.tartarus places it on the theta 132-316deg perimeter arc,
      // which the fixed 45deg play camera puts on the top and side EDGES of
      // frame. The composition was centrifugal: the brightest mass in the image
      // was the border, the play space was a hole in the middle, and at 1/16
      // greyscale the character could not be found at all.
      // Cut to ~0.45x they read as background firelight — still the warm note
      // that says "underworld chamber", no longer the subject of the picture.
      // `distance` comes down with them so the pool stays a POOL and does not
      // creep further across the floor as it dims.
      { pos: [ -8.30, 1.7,   9.21], color: '#ffb070', intensity: 74,  distance: 9.0, speed: 1.00 },
      { pos: [-12.39, 1.7,   0.43], color: '#ffb070', intensity: 74,  distance: 9.0, speed: 0.83 },
      { pos: [ -8.92, 1.7,  -8.61], color: '#ff9a52', intensity: 78,  distance: 8.6, speed: 1.21 },
      { pos: [  0.00, 1.7, -12.40], color: '#ff9a52', intensity: 78,  distance: 8.6, speed: 0.72 },
      { pos: [  8.92, 1.7,  -8.61], color: '#ffb070', intensity: 74,  distance: 9.0, speed: 0.94 },
      // COOL #5fd0ff washes on the perimeter masonry, the column capitals and
      // the gate. §9.4 needs the mid/background architecture to sit a full value
      // band ABOVE the ground plane, and §9.6 needs the complement at scale —
      // these do both jobs at once, and they are aimed at surfaces the floor
      // barely sees (floor.tartarus litGain keeps what does reach it negligible).
      // COOL COMES UP AS WARM GOES DOWN (§9.6, §12). The top band of every play
      // frame used to be bright because a 1.70-intensity bloom was smearing the
      // brazier cores across it; with that gone the mid-ground architecture has
      // to be lit by something REAL, and §12 says the mid band is the brightest
      // band in the picture. These are the lights that do it, and because they
      // are #5fd0ff they also carry the mandated complement — warm was 40-47%
      // of saturated pixels against cyan at 2.4-5.2% (the §9.6 floor is 8%).
      // Raising cool while cutting warm moves both problems with one lever.
      // §11.2 LIGHT THE MID-GROUND, and light it UNEVENLY. The chamber points at
      // focalAngle (225deg, i.e. -X-Z, which the fixed 45deg play yaw puts dead
      // centre at the top of frame). The two washes that flank that gate are the
      // brightest lights in the room after the key — they are what makes the
      // focal bays the top value band and what the ashlar's new chamfers catch.
      // The three that fall on plain perimeter come DOWN: an evenly washed
      // perimeter is what turned the top of every play frame into one continuous
      // salmon band with no depth in it (§1.1, §11.1).
      { pos: [ -4.6, 5.4, -12.6], color: '#7ad8ff', intensity: 980, distance: 22, speed: 0.31, flicker: 0.09 },
      { pos: [-12.6, 5.0,  -4.6], color: '#5fd0ff', intensity: 880, distance: 22, speed: 0.61, flicker: 0.12 },
      { pos: [  0.0, 4.6, -13.4], color: '#5fd0ff', intensity: 340, distance: 17, speed: 0.44, flicker: 0.14 },
      { pos: [ 13.2, 6.6,  -9.4], color: '#3fb8ff', intensity: 230, distance: 18, speed: 0.27, flicker: 0.09 },
      { pos: [-14.6, 5.0,   3.6], color: '#5fd0ff', intensity: 250, distance: 17, speed: 0.52, flicker: 0.14 },
    ],
    // ── THE WALL WASH (§1.1 three bands, §11.2 "light the mid-ground") ─────
    // WHAT WAS WRONG. Every light above aims DOWN into the arena or sits
    // OUTSIDE the wall. The key travels (0.646,-0.615,-0.452), so on the far
    // arc — the 135-315deg band the fixed 45deg camera puts across the top of
    // every frame — the wall's inward-facing surface has N.L = -0.14 and
    // receives nothing but hemi 0.75 and ambient 0.34. The five cool washes
    // stand at radius 13.4-15.0 against a wall at 13.0: they are BEHIND it,
    // lighting a face no camera in this game will ever see. And the braziers
    // sit at y=1.7 with distance 8.6-9.0, a bubble that dies two metres up.
    // Measured consequence: architecture in the 0.75R-1.35R band medians 0.075
    // display against a floor at 0.058-0.064. The mid-ground was not a band. It
    // was the floor's value, standing up.
    //
    // WHAT THIS IS. Six upward-raked practicals INSIDE the colonnade (r 9.2,
    // i.e. clear of the column surface at 9.98) at y 6.2, each aimed up and
    // outward at the wall at r 14.6 / y 11.6. They are SPOT lights and the cone
    // axis rises at 45deg with a 35deg half-angle, so the lowest ray in the cone
    // still climbs at ~10deg: THE GROUND PLANE IS NOT IN THE VOLUME AT ALL.
    // That is the layer mask, done geometrically — it cannot be defeated by a
    // later material change, and it costs no per-object layer bookkeeping in a
    // world file this agent does not own.
    //
    // WHAT THEY LIGHT: the upper third of every far column shaft, its capital,
    // the architrave, the wall face above the dado and the crowning cornice —
    // §9.5's "light the EDGES of architecture, not its faces", and the surfaces
    // whose gold cyma and egg-and-dart give the frame an honest specular
    // highlight band instead of a bloom halo (§7, §14.10).
    //
    // WARM CENTRE, COOL FLANKS. The chamber points at focalAngle 225deg. The
    // two washes flanking it are the strongest and the warmest, so the eye is
    // pulled to the gate; the pair at the frame edges are #8fd8ff and #7ad8ff,
    // which keeps the mandated complement (§1.2, §9.6) ON ARCHITECTURE rather
    // than only in the rim, and stops a uniformly amber band from becoming the
    // "one salmon smear" §11.1 warns about.
    //
    // NOT POOLED. quality ultra budgets exactly 10 pooled point lights and the
    // practicals above spend all 10, so an acquireLight() here would be
    // silently dropped in the capture harness — which has already happened once
    // in this project. These are dedicated, like `subject`.
    // AUTHORED IN ROOM SPACE, NOT WORLD SPACE. The chamber's radial profile
    // wobbles +-11% per angle and every archetype has a different radius, so a
    // hard-coded xz would sit inside a column in one room and out in the void in
    // the next. `theta` is degrees CCW from +X; `rIn`/`rOut` are metres measured
    // INWARD/OUTWARD from the wall at that angle (world.radiusAt), which keeps
    // the source clear of the colonnade (wall - 2.35 - 0.67 shaft) in any plan.
    wallWash: [
      // STAND BACK FROM THE WALL. A source 2m off masonry is a hotspot, not a
      // wash — inverse-square puts 5x more light on the stone beside it than on
      // the stone two metres up, and that reads as a blown blob. At 6.4m the
      // same cone lands 14-34 irradiance across the whole upper storey, a 2.4x
      // vertical gradient the eye reads as modelling. Standing back also lifts
      // the source ABOVE the colonnade capitals (7.6 against a 8.9m order), so
      // the columns take the light on their top drums and their gold capitals —
      // §9.5's lit EDGE — instead of a searchlight halfway up the shaft.
      // WHERE THE MID-GROUND ACTUALLY IS, MEASURED. The first two passes aimed
      // this ring at the wall at r~14 / y~9 and moved the frame by NOTHING —
      // 0, 1000, 4000 and 20000 candela produced byte-identical frames. A
      // raycast down the beam axis found the cause: the beam WAS hitting
      // `wall.upper` at r 14.0, but from a 43-52deg downward camera that
      // surface is behind the arcade and barely appears on screen. What the
      // lens actually sees of the mid-ground is the LOW band — `door.pier` and
      // `arch.voussoir` at r 11.2, `wall.ashlar` at 12.6, `wall.meander` at
      // 12.9, and the column shafts — all of it between y 2 and y 7. Lighting
      // the wall the plan drawing shows instead of the wall the camera frames
      // is the same class of mistake as measuring the floor in the centre 70%.
      //
      // So these are FOOT-OF-WALL uplighters: at the base of the arcade
      // (1.9m inside the wall face), 0.6m off the stage, raking up its face.
      // The axis rises at 61deg and the half-angle is 47deg, so the lowest ray
      // in the cone still climbs 14deg — the ground plane is outside the
      // volume, which is the whole contract of doing this with spots.
      // Measured on the live play camera: far arcade +29%, mid frame +24%,
      // floor band -2% (it goes DOWN, because the auto-exposure responds to a
      // brighter mid-ground by pulling the stage further under it). Blown
      // pixels: 0.00%. That is a band bought by lighting the correct surface,
      // not by lifting anything and not by bloom.
      //
      // PENUMBRA IS NOT SOFTNESS, IT IS THE SIZE OF THE HOLE IN THE MIDDLE.
      // three.js takes the full-intensity core out to angle*(1-penumbra), so at
      // 0.90 only the innermost 10% of the cone was ever at full power and the
      // other 90% was a falloff ramp. The first pass measured +0.009 on the
      // mid band for 1150 candela because ~5/6 of every cone was penumbra: the
      // wash was landing, in a thin ring, on the cornice alone. 0.45 puts the
      // wall band from y~7 to y~12 inside the flat core where it belongs and
      // spends the soft edge on the two ends of the gradient.
      // The axis drops with it (yOut 9.2, elevation ~29deg) so the core sits on
      // the upper storey rather than sailing over the parapet into the void,
      // and `angle` comes in to 0.48 so the lowest ray still climbs ~2deg: the
      // ground plane stays outside the volume, which is the whole contract.
      // THE SOURCE HEIGHT IS THE ARTIFACT CONTROL. At y 0.6 these sat below the
      // arena curb, so the hottest thing in the cone was the near lip of the
      // apron — a stepped ring of slabs — and it came back as a hard salmon
      // strip with a black stair-stepped edge running down the right of the
      // gameplay frame. That is §7's "aliased edges / programmer-art blocks"
      // paid for with a value band, i.e. exactly the trade this pass exists to
      // refuse. y 2.4 puts the whole apron BELOW the source: a cone that only
      // ascends cannot light anything under its own origin, so the curb drops
      // out of the picture entirely and the light starts on the arcade face
      // where it was aimed. The lowest ray still climbs 15deg — the ground
      // plane remains outside the volume by construction.
      { theta: 138, rIn: 1.9, y: 1.6, rOut: -0.3, yOut: 5.4, color: '#8fd8ff', intensity: 2350, distance: 14, angle: 0.78, penumbra: 0.50, speed: 0.29, flicker: 0.08 },
      { theta: 174, rIn: 1.9, y: 1.6, rOut: -0.3, yOut: 5.4, color: '#ff9e60', intensity: 2550, distance: 14, angle: 0.78, penumbra: 0.50, speed: 0.47, flicker: 0.13 },
      { theta: 210, rIn: 1.9, y: 1.6, rOut: -0.3, yOut: 5.4, color: '#ffbe86', intensity: 1850, distance: 15, angle: 0.78, penumbra: 0.52, speed: 0.36, flicker: 0.11 },
      { theta: 246, rIn: 1.9, y: 1.6, rOut: -0.3, yOut: 5.4, color: '#ffb070', intensity: 1850, distance: 15, angle: 0.78, penumbra: 0.52, speed: 0.61, flicker: 0.11 },
      { theta: 282, rIn: 1.9, y: 1.6, rOut: -0.3, yOut: 5.4, color: '#7ad8ff', intensity: 3050, distance: 14, angle: 0.78, penumbra: 0.50, speed: 0.41, flicker: 0.09 },
      { theta: 320, rIn: 1.9, y: 1.6, rOut: -0.3, yOut: 5.4, color: '#ffa668', intensity: 1860, distance: 14, angle: 0.78, penumbra: 0.50, speed: 0.53, flicker: 0.12 },
    ],
  },
  asphodel: {
    key:    { color: '#ffc884', intensity: 8.8, dir: [0.586, -0.668, -0.459] },
    hemi:   { sky: '#4e4a94', ground: '#5a1c06', intensity: 0.24 },
    bounce: { color: '#e0600f', intensity: 0.30, size: [30, 30], y: 0.2 },
    rim:    { color: '#33e0c0', dir: [-0.66, 0.32, 0.68], intensity: 2.4, power: 2.2, wrap: 0.34 },
    ambient:{ color: '#231b46', intensity: 0.05 },
    godrayAnchor: [0.26, -0.08],
    env:    { zenith: '#0e0c26', horizon: '#3a1c0e', nadir: '#4a1605', keyGain: 16.0, keySharp: 220, keyWide: 0.06, rimGain: 1.9, rimSharp: 34, bounce: '#ff6a12', bounceGain: 0.07, intensity: 0.32 },
    practicals: [
      { pos: [ 12.0, 0.6,  -4.0], color: '#ff8c1a', intensity: 120, distance: 13, speed: 0.9 },
      { pos: [-10.0, 0.6,   9.0], color: '#ff8c1a', intensity: 120, distance: 13, speed: 1.15 },
      { pos: [  2.0, 0.5,  13.0], color: '#fff0b0', intensity: 80, distance: 11, speed: 1.4 },
      { pos: [ -7.0, 0.5, -12.0], color: '#c22a06', intensity: 60, distance: 12, speed: 0.62 },
    ],
  },
  elysium: {
    key:    { color: '#fff0d0', intensity: 9.2, dir: [0.632, -0.630, -0.451] },
    hemi:   { sky: '#9a90cc', ground: '#1c4c3a', intensity: 0.30 },
    bounce: { color: '#c9bda4', intensity: 0.32, size: [30, 30], y: 0.25 },
    rim:    { color: '#ff5fa8', dir: [-0.58, 0.40, 0.71], intensity: 2.2, power: 2.3, wrap: 0.30 },
    ambient:{ color: '#3d3560', intensity: 0.06 },
    godrayAnchor: [0.24, 1.04],
    env:    { zenith: '#141c40', horizon: '#332f4c', nadir: '#13201c', keyGain: 20.0, keySharp: 220, keyWide: 0.07, rimGain: 1.5, rimSharp: 34, bounce: '#3fa86a', bounceGain: 0.05, intensity: 0.36 },
    practicals: [
      { pos: [ 10.5, 2.2,  -7.0], color: '#ffe14d', intensity: 70, distance: 11, speed: 0.8 },
      { pos: [-10.5, 2.2,   7.0], color: '#ffe14d', intensity: 70, distance: 11, speed: 1.05 },
      { pos: [  0.0, 3.0, -13.0], color: '#ff5fa8', intensity: 46, distance: 11, speed: 0.55 },
      { pos: [  7.0, 1.4,  11.0], color: '#3fa86a', intensity: 40, distance: 10, speed: 1.3 },
    ],
  },
};

export class LightRig {
  constructor(){
    this.biome = DEFAULT_BIOME;
    this.keyDir = new THREE.Vector3(0.621, -0.641, -0.451).normalize();
    this.keyColor = new THREE.Color('#ff6a44');
    this.godrayAnchor = [0.22, 1.06];
    this.pool = [];
    this._practicals = [];
    this.washes = [];
    this._t = 0;
    this.params = { key: true, fill: true, bounce: true, practicals: true, subject: true, wallWash: true, shadows: true, exposureBias: 1 };
  }

  async init(ctx){
    this.ctx = ctx;
    const q = (ctx.quality && ctx.quality.render) || {};
    this.q = q;
    this.rng = (ctx.rng && ctx.rng.fork) ? ctx.rng.fork('lighting') : null;

    this.group = new THREE.Group();
    this.group.name = 'lightrig';
    ctx.scene.add(this.group);

    // ── key ────────────────────────────────────────────────────────────────
    this.key = new THREE.DirectionalLight('#ffb894', 12.0);
    this.key.name = 'key';
    this.key.castShadow = !!q.shadows && ctx.quality.shadows !== false;
    const sm = q.shadowMap ?? 2048;
    this.key.shadow.mapSize.set(sm, sm);
    // §1.3: the terminator is a painted edge. A wide PCF radius turns a cast
    // shadow into a smudge, which is exactly what "reads as dirt" looks like.
    // §9.7 "cast shadows must read as shadows, not stains".
    //
    // MEASURED, NOT ASSUMED (round-4 pass). The old line clamped this to
    // Math.min(1.0, shadowRadius*0.6) = 0.84 texels and justified it against a
    // "38u frustum". Both numbers were wrong: fitShadows() sizes the ortho half
    // to bounds.r + 1.35, and the shipped chamber measures bounds.r = 13.005,
    // so the frustum is 28.7u across, not 38. At the ultra map (3072) that is
    // 0.00934 u/texel, and at the 03_hero_char framing (~268 px per world unit)
    // one texel is ~3.3 screen px — i.e. 0.84 texels was a sub-3px penumbra
    // that the 5-tap Vogel disk could not spend on anything. It is a knob that
    // was doing nothing, dressed as a considered decision.
    //
    // three r185's PCFShadowMap is NOT the one-tap hard variant it used to be:
    // shadowmap_pars_fragment now does five vogelDiskSample() taps on a
    // sampler2DShadow at `shadowRadius * texelSize`, dithered per pixel by
    // interleavedGradientNoise. radius IS the penumbra knob, and PCFSoftShadowMap
    // is deprecated in this revision (WebGLShadowMap warns and silently falls
    // back to PCFShadowMap), so switching the renderer's type buys a console
    // warning and nothing else. See renderer.js.
    //
    // The tier value straight through gives ultra 1.5 texels (~5px close, ~2px
    // in the wide pose): a drawn edge with a resolved shoulder, which is what
    // "slightly hardened, not a soft PBR falloff" actually looks like. The 2x
    // SSAA resolve averages four dithered samples per output pixel, so the
    // Vogel jitter integrates instead of reading as noise.
    this.key.shadow.radius = Math.max(0.5, q.shadowRadius ?? 1.4);
    // A tight ortho frustum around the arena keeps the texel density high, which
    // is what makes the shadow read as a painted shape rather than a smear.
    this.key.shadow.bias = -0.00015;
    // A large normalBias walks the shadow off the base of whatever casts it,
    // which is exactly the contact the eye uses to plant an object on a floor.
    this.key.shadow.normalBias = 0.012;
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 60;
    this.keyTarget = new THREE.Object3D();
    this.keyTarget.name = 'key.target';
    this.key.target = this.keyTarget;
    this.group.add(this.key, this.keyTarget);

    // ── fill (hemisphere, tinted with the biome shadow colour) ─────────────
    this.hemi = new THREE.HemisphereLight('#4a3a72', '#3a1d52', 0.26);
    this.hemi.name = 'fill.hemi';
    this.group.add(this.hemi);

    // A whisper of true ambient so nothing in the frame is a dead 0.0 — the
    // bible wants ink, not void, in the shadow shapes.
    this.ambient = new THREE.AmbientLight('#3a1d52', 0.075);
    this.ambient.name = 'fill.ambient';
    this.group.add(this.ambient);

    // ── subject key: the art-directed light that follows the HERO ──────────
    // See the RIGS note. This is deliberately NOT drawn from the practical
    // pool: the ultra tier budgets exactly 10 pooled lights and the Tartarus
    // rig authors exactly 10 practicals, so a pooled subject light would have
    // been silently dropped in the capture harness — the one place the frame
    // is actually judged. It is also never released, because the subject is
    // never optional.
    this.subject = new THREE.PointLight('#ffd2a4', 0, 6.2, 2.0);
    this.subject.name = 'subject.key';
    this.subject.castShadow = false;
    this.subjectOffset = new THREE.Vector3(0.85, 2.05, 1.25);
    this._subjectPos = new THREE.Vector3(0, 1.0, 0);
    this.group.add(this.subject);

    // ── wall wash: the mid-ground band, as upward-raked spot practicals ────
    // Dedicated for the same reason `subject` is: the pooled budget is fully
    // spent by the authored practicals, and a wash that vanishes at ultra is a
    // wash that never appears in a single judged frame.
    // SPOT, not point, is load-bearing. A point light at y=6 inside the room
    // paints the floor harder than it paints the wall (the floor's normal faces
    // it straight on); a cone that only opens upward physically cannot reach the
    // ground plane, so the §9 dark stage is safe by construction rather than by
    // a number someone has to keep re-tuning.
    this.washes = [];
    for(let i = 0; i < 6; i++){
      const s = new THREE.SpotLight('#ffb070', 0, 14, 0.78, 0.50, 2.0);
      s.name = 'wash.' + i;
      s.castShadow = false;
      s.visible = false;
      s.target = new THREE.Object3D();
      s.target.name = 'wash.' + i + '.target';
      this.group.add(s, s.target);
      this.washes.push(s);
    }

    // ── floor bounce (fake GI) ─────────────────────────────────────────────
    // TWO plates, not one. `bounce` is a small centre POOL with real falloff to
    // the skirt (a 26x26 plate over a 32u arena is a uniform wash, which is what
    // made the ground read as one flat slab); `bounce2` is the §3 fake bounce
    // proper — wide, dim, sitting at 0.15 so it grazes, and tinted with the
    // FLOOR albedo so the light coming back off the stone is the stone's colour.
    try {
      const { RectAreaLightUniformsLib } = await import('three/examples/jsm/lights/RectAreaLightUniformsLib.js');
      RectAreaLightUniformsLib.init();
      this.bounce = new THREE.RectAreaLight('#6e3560', 0.16, 13, 13);
      this.bounce.name = 'bounce';
      this.bounce.position.set(0, 0.9, 0);
      this.bounce.rotation.x = -Math.PI / 2;      // facing up off the floor
      this.group.add(this.bounce);
      this.bounce2 = new THREE.RectAreaLight('#3c1d25', 0.40, 30, 30);
      this.bounce2.name = 'bounce.floor';
      this.bounce2.position.set(0, 0.15, 0);
      this.bounce2.rotation.x = -Math.PI / 2;
      this.group.add(this.bounce2);
    } catch(e){
      // RectAreaLight unavailable — fall back to a very wide, dim point light.
      this.bounce = new THREE.PointLight('#6e3560', 4, 60, 1.2);
      this.bounce.name = 'bounce.fallback';
      this.bounce.position.set(0, 0.9, 0);
      this.group.add(this.bounce);
      this.bounce2 = null;
    }

    // ── rim: an art-directed constant published for the material system ────
    this.rim = {
      color: new THREE.Color('#5fd0ff'),
      dir: new THREE.Vector3(-0.62, 0.36, 0.70).normalize(),
      intensity: 5.0, power: 1.5, wrap: 0.50,
    };
    // Shared uniform block. materials/library.js should bind these objects
    // straight into its painterly shaders (onBeforeCompile) so a biome change
    // costs zero recompiles.
    this.rimUniforms = {
      uRimColor:     { value: this.rim.color },
      uRimDir:       { value: this.rim.dir },
      uRimIntensity: { value: this.rim.intensity },
      uRimPower:     { value: this.rim.power },
      uRimWrap:      { value: this.rim.wrap },
      uKeyDir:       { value: this.keyDir },
      uKeyColor:     { value: this.keyColor },
      uInkColor:     { value: new THREE.Color('#3a1d52') },
    };

    // ── pooled practical lights ────────────────────────────────────────────
    this.budget = Math.max(2, q.practicalLights ?? 8);
    for(let i = 0; i < this.budget; i++){
      const l = new THREE.PointLight('#ffffff', 0, 12, 1.6);
      l.name = 'practical.' + i;
      l.visible = false;
      l.castShadow = false;
      l.userData.free = true;
      this.group.add(l);
      this.pool.push(l);
    }
    this._flickers = [];
    // +4 spare for transient FX, +6 so every wall wash guts on its own noise
    // (six lights sharing one seed pulse in unison and read as a global dimmer).
    for(let i = 0; i < this.budget + 10; i++) this._flickers.push(new Flicker(this.rng));

    // ── procedural IBL ────────────────────────────────────────────────────
    // Without an environment, every metal in the game (gold filigree, bronze,
    // iron) resolves to black: a metal has no diffuse lobe, it can only reflect.
    // So the rig authors its own tiny HDR equirect and prefilters it. Zero assets.
    this._pmrem = null;
    this._envRT = null;
    this._envTex = null;

    // ── atmosphere (we own its lifecycle) ─────────────────────────────────
    this.atmosphere = new Atmosphere();
    await this.atmosphere.init(ctx);
    ctx.atmosphere = this.atmosphere;

    const start = (ctx.run && ctx.run.biome) || (ctx.world && ctx.world.biome) || DEFAULT_BIOME;
    this.setBiome(start, ctx);

    // pipeline self-test rig (?renderdebug=1) — see render/debugscene.js
    try {
      if(typeof location !== 'undefined' && new URLSearchParams(location.search).has('renderdebug')){
        const { RenderDebugScene } = await import('./debugscene.js');
        this.debugScene = new RenderDebugScene().build(ctx);
        ctx.renderDebug = this.debugScene;
      }
    } catch(e){ /* debug rig is optional; never break the game for it */ }

    ctx.events?.on?.('biome.changed', ({ name }) => this.setBiome(name, ctx));
    ctx.events?.on?.('room.entered', () => this.fitShadows(ctx));
    // the chamber re-rolls its radial profile per room; the wash follows it
    ctx.events?.on?.('room.built', () => this.placeWashes(ctx));
  }

  // ─────────────────────────────────────────────────────────────── biome ──
  setBiome(name, ctx = this.ctx){
    const rig = RIGS[name] || RIGS[DEFAULT_BIOME];
    this.biome = RIGS[name] ? name : DEFAULT_BIOME;
    this.rigDef = rig;

    this.key.color.set(rig.key.color);
    this.key.intensity = rig.key.intensity;
    this.keyColor.copy(this.key.color);
    this.keyDir.fromArray(rig.key.dir).normalize();

    this.hemi.color.set(rig.hemi.sky);
    this.hemi.groundColor.set(rig.hemi.ground);
    this.hemi.intensity = rig.hemi.intensity;

    this.ambient.color.set(rig.ambient.color);
    this.ambient.intensity = rig.ambient.intensity;

    // subject key (every biome gets one; fall back to a warm neutral)
    {
      const sj = rig.subject || { color: '#ffd2a4', intensity: 9.0, distance: 6.2, decay: 2.0, offset: [0.85, 2.05, 1.25] };
      this.subject.color.set(sj.color);
      this.subject.userData.base = sj.intensity;
      this.subject.intensity = this.params.subject === false ? 0 : sj.intensity;
      this.subject.distance = sj.distance;
      this.subject.decay = sj.decay ?? 2.0;
      this.subjectOffset.fromArray(sj.offset || [0.85, 2.05, 1.25]);
    }

    if(this.bounce){
      this.bounce.color.set(rig.bounce.color);
      this.bounce.intensity = rig.bounce.intensity;
      if(this.bounce.isRectAreaLight){
        this.bounce.width = rig.bounce.size[0];
        this.bounce.height = rig.bounce.size[1];
      }
      this.bounce.position.y = rig.bounce.y;
    }
    if(this.bounce2){
      const b2 = rig.bounce2 || { color: rig.bounce.color, intensity: 0, size: [30, 30], y: 0.15 };
      this.bounce2.color.set(b2.color);
      this.bounce2.intensity = b2.intensity;
      if(this.bounce2.isRectAreaLight){ this.bounce2.width = b2.size[0]; this.bounce2.height = b2.size[1]; }
      this.bounce2.position.y = b2.y;
    }

    this.rim.color.set(rig.rim.color);
    this.rim.dir.fromArray(rig.rim.dir).normalize();
    this.rim.intensity = rig.rim.intensity;
    this.rim.power = rig.rim.power;
    this.rim.wrap = rig.rim.wrap;
    this.rimUniforms.uRimIntensity.value = this.rim.intensity;
    this.rimUniforms.uRimPower.value = this.rim.power;
    this.rimUniforms.uRimWrap.value = this.rim.wrap;
    this.rimUniforms.uInkColor.value.set((GRADES[this.biome] || GRADES[DEFAULT_BIOME]).ao.ink);
    this.godrayAnchor = rig.godrayAnchor.slice();

    // Rebuild the prefiltered sky FIRST: the material system binds it straight
    // off `this.envTexture`, so it has to exist before the handshake below.
    if(ctx) this._buildEnvironment(ctx, rig);

    // hand the rim constant to the material system — set it, don't reimplement it
    const payload = {
      color: this.rim.color, dir: this.rim.dir, intensity: this.rim.intensity,
      power: this.rim.power, wrap: this.rim.wrap,
      keyDir: this.keyDir, keyColor: this.keyColor,
      ink: this.rimUniforms.uInkColor.value, uniforms: this.rimUniforms, biome: this.biome,
      env: this.envTexture || null, keyIntensity: this.key.intensity,
    };
    if(ctx && ctx.mats){
      // The material system owns the painterly shading; we only publish the
      // constants. setRim() also carries the biome, so one call retunes every
      // painted material's rim colour, shadow ink and key reference together.
      if(typeof ctx.mats.setRim === 'function') ctx.mats.setRim(payload);
      else if(typeof ctx.mats.setLighting === 'function') ctx.mats.setLighting(payload);
      else if(typeof ctx.mats.setBiome === 'function') ctx.mats.setBiome(this.biome);
    }
    ctx?.events?.emit?.('lighting.rim', payload);

    // authored wall wash for this biome (dedicated spots, never pooled)
    this._washDefs = rig.wallWash || [];
    this.placeWashes(ctx);

    // authored practicals for this biome
    this._releaseAllPracticals();
    if(this.params.practicals){
      for(const p of rig.practicals){
        const l = this.acquireLight({
          color: p.color, intensity: p.intensity, distance: p.distance, decay: 2.0,
          pos: p.pos, flicker: p.flicker ?? 0.42, speed: p.speed, kind: 'practical',
        });
        if(l) this._practicals.push(l);
      }
    }

    if(ctx){
      ctx.post?.setBiome?.(this.biome);
      this.atmosphere?.setBiome?.(this.biome, ctx);
      this.fitShadows(ctx);
    }
    return this;
  }

  // ────────────────────────────────────────────────────────── wall wash ──
  /**
   * Park the wall wash on the CURRENT room's radial profile. Called on biome
   * change and again on every `room.built`, because the chamber re-rolls its
   * plan per room and a wash authored against the old radius would end up
   * inside a column or out past the wall in the next one.
   */
  placeWashes(ctx = this.ctx){
    const defs = this._washDefs || [];
    const w = ctx && ctx.world;
    // radiusAt is the chamber's public radial profile; fall back to the arena
    // bounds, then to a sane default, so a stubbed world still lights.
    const rAt = (w && typeof w.radiusAt === 'function')
      ? (a) => w.radiusAt(a)
      : () => ((w && w.bounds && w.bounds.r) || 13.0);
    const cx = (w && w.center) ? (w.center.x || 0) : 0;
    const cz = (w && w.center) ? (w.center.z || 0) : 0;
    for(let i = 0; i < this.washes.length; i++){
      const s = this.washes[i], d = defs[i];
      if(!d || this.params.wallWash === false){
        s.visible = false; s.intensity = 0; s.userData.base = 0; continue;
      }
      const a = (d.theta || 0) * Math.PI / 180;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rw = rAt(a);
      const ri = Math.max(2.0, rw - (d.rIn ?? 3.9));
      const ro = rw - (d.rOut ?? -1.6);
      s.color.set(d.color);
      s.userData.base = d.intensity;
      s.userData.flicker = d.flicker ?? 0.10;
      s.userData.speed = d.speed ?? 0.5;
      s.userData.phase = this.rng ? this.rng.f() * 100 : 0;
      s.userData.flick = this._flickers[(this.budget + 4 + i) % this._flickers.length];
      s.intensity = d.intensity;
      s.distance = d.distance ?? 16;
      s.angle = d.angle ?? 0.62;
      s.penumbra = d.penumbra ?? 0.88;
      s.decay = d.decay ?? 2.0;
      s.position.set(cx + ca * ri, d.y ?? 6.2, cz + sa * ri);
      s.target.position.set(cx + ca * ro, d.yOut ?? 11.6, cz + sa * ro);
      s.target.updateMatrixWorld();
      s.visible = true;
    }
    return this;
  }

  // ───────────────────────────────────────────────────────── environment ──
  /**
   * Author a small HDR equirect in code and prefilter it with PMREM.
   * Content: the biome's vertical value ramp, a hot lobe where the key lives, a
   * cool complement lobe where the rim lives, and a floor-bounce lift below the
   * horizon. This is the specular counterpart to the hemisphere fill.
   */
  _buildEnvironment(ctx, rig){
    const renderer = ctx.renderer;
    if(!renderer || !rig || !rig.env) return;
    const E = rig.env;
    const W = 128, H = 64;
    const data = new Float32Array(W * H * 4);

    const zen = new THREE.Color(E.zenith), hor = new THREE.Color(E.horizon), nad = new THREE.Color(E.nadir);
    const keyC = new THREE.Color(rig.key.color);
    const rimC = new THREE.Color(rig.rim.color);
    const bnc = new THREE.Color(E.bounce || '#000000');
    const kd = new THREE.Vector3().fromArray(rig.key.dir).normalize();   // travel direction
    const rd = new THREE.Vector3().fromArray(rig.rim.dir).normalize();
    const smooth = (t) => { t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); };

    for(let j = 0; j < H; j++){
      const v = (j + 0.5) / H;
      const y = v * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      for(let i = 0; i < W; i++){
        const u = (i + 0.5) / W;
        const phi = (u - 0.5) * Math.PI * 2;
        const dx = r * Math.cos(phi), dz = -r * Math.sin(phi);

        let cr, cg, cb;
        if(y < 0){ const t = smooth((y + 1) / 1.0); cr = nad.r + (hor.r - nad.r) * t; cg = nad.g + (hor.g - nad.g) * t; cb = nad.b + (hor.b - nad.b) * t; }
        else     { const t = smooth(y);            cr = hor.r + (zen.r - hor.r) * t; cg = hor.g + (zen.g - hor.g) * t; cb = hor.b + (zen.b - hor.b) * t; }

        // hot key lobe (the direction the light comes FROM is -keyDir)
        let d = -(dx * kd.x + y * kd.y + dz * kd.z);
        if(d > 0){
          const k = Math.pow(d, E.keySharp || 220) * E.keyGain;
          // plus a broad, low-energy warm wash so ROUGH metals still read as
          // metal instead of collapsing to black between the sun and the base
          const kw = Math.pow(d, 2) * (E.keyWide || 0);
          cr += keyC.r * (k + kw); cg += keyC.g * (k + kw); cb += keyC.b * (k + kw);
        }
        // cool complement lobe where the art-directed rim lives
        let d2 = dx * rd.x + y * rd.y + dz * rd.z;
        if(d2 > 0){ const k2 = Math.pow(d2, E.rimSharp || 34) * E.rimGain; cr += rimC.r * k2; cg += rimC.g * k2; cb += rimC.b * k2; }
        // floor bounce below the horizon
        const bk = smooth((-y - 0.05) / 0.6) * (E.bounceGain || 0);
        cr += bnc.r * bk; cg += bnc.g * bk; cb += bnc.b * bk;

        const o = (j * W + i) * 4;
        data[o] = cr; data[o + 1] = cg; data[o + 2] = cb; data[o + 3] = 1;
      }
    }

    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;

    try {
      if(!this._pmrem){ this._pmrem = new THREE.PMREMGenerator(renderer); this._pmrem.compileEquirectangularShader(); }
      const rt = this._pmrem.fromEquirectangular(tex);
      if(this._envRT) this._envRT.dispose();
      this._envRT = rt;
      ctx.scene.environment = rt.texture;
      if('environmentIntensity' in ctx.scene) ctx.scene.environmentIntensity = E.intensity ?? 1;
      this.envTexture = rt.texture;
    } catch(e){
      // If PMREM is unavailable the raw equirect still beats a black metal.
      ctx.scene.environment = tex;
      this.envTexture = tex;
    }
    if(this._envTex) this._envTex.dispose();
    this._envTex = tex;
  }

  // ───────────────────────────────────────────────────────────── shadows ──
  /** Fit the key light's ortho frustum tightly to the arena (crisp, no acne). */
  fitShadows(ctx = this.ctx){
    const r = ((ctx && ctx.world && ctx.world.bounds && ctx.world.bounds.r) || 16);
    const cx = (ctx && ctx.world && ctx.world.center) ? ctx.world.center : { x: 0, y: 0, z: 0 };
    // Clamp the ortho frustum to the arena itself (+2u for the wall and the
    // gate). Every texel spent outside the island is a texel the terminator
    // does not get.
    // Every texel spent outside the island is a texel the terminator does not
    // get: 1.35 instead of 2.0 buys ~7% more density for free.
    const half = r + 1.35;
    const dist = r * 1.9 + 10;
    this.keyTarget.position.set(cx.x || 0, (cx.y || 0) + 1.0, cx.z || 0);
    this.key.position.set(
      this.keyTarget.position.x - this.keyDir.x * dist,
      this.keyTarget.position.y - this.keyDir.y * dist,
      this.keyTarget.position.z - this.keyDir.z * dist,
    );
    const c = this.key.shadow.camera;
    c.left = -half; c.right = half; c.top = half; c.bottom = -half;
    c.near = Math.max(0.5, dist - r * 1.55);
    c.far = dist + r * 1.75;
    c.updateProjectionMatrix();
    this.key.shadow.needsUpdate = true;
    this.keyTarget.updateMatrixWorld();
    return this;
  }

  // ──────────────────────────────────────────────────────── light pool ──
  /**
   * Borrow a pooled point light. Returns null when the budget is spent — callers
   * must handle that (emissive-only fallback), which is the whole point of the
   * budget. Options: {color,intensity,distance,decay,pos,flicker,speed,kind}
   */
  acquireLight(opts = {}){
    const l = this.pool.find(p => p.userData.free);
    if(!l) return null;
    l.userData.free = false;
    l.userData.kind = opts.kind || 'fx';
    l.userData.base = opts.intensity ?? 10;
    l.userData.flicker = opts.flicker ?? 0;
    l.userData.speed = opts.speed ?? 1;
    l.userData.phase = this.rng ? this.rng.f() * 100 : 0;
    l.userData.flick = this._flickers[this.pool.indexOf(l) % this._flickers.length];
    l.color.set(opts.color || '#ffffff');
    l.intensity = l.userData.base;
    l.distance = opts.distance ?? 12;
    l.decay = opts.decay ?? 1.7;
    if(opts.pos) l.position.set(opts.pos[0] ?? opts.pos.x ?? 0, opts.pos[1] ?? opts.pos.y ?? 0, opts.pos[2] ?? opts.pos.z ?? 0);
    l.visible = true;
    return l;
  }

  releaseLight(l){
    if(!l || l.userData.free) return;
    l.userData.free = true;
    l.visible = false;
    l.intensity = 0;
    const i = this._practicals.indexOf(l);
    if(i >= 0) this._practicals.splice(i, 1);
  }

  _releaseAllPracticals(){
    for(const l of this._practicals.slice()) this.releaseLight(l);
    this._practicals.length = 0;
  }

  /** Number of pooled lights still available. */
  get freeLights(){ return this.pool.reduce((n, l) => n + (l.userData.free ? 1 : 0), 0); }

  // ────────────────────────────────────────────────────────────── frame ──
  update(dt, ctx){
    this._t += dt;
    this.key.visible = this.params.key;
    this.hemi.visible = this.params.fill;
    this.ambient.visible = this.params.fill;
    if(this.bounce) this.bounce.visible = this.params.bounce;
    if(this.bounce2) this.bounce2.visible = this.params.bounce;
    this.key.castShadow = this.params.shadows && !!this.q.shadows && ctx.quality.shadows !== false;

    // SMOOTHED-NOISE flicker (never a sine wave)
    for(const l of this.pool){
      if(l.userData.free || !l.userData.flicker) continue;
      const f = l.userData.flick;
      if(!f) continue;
      const n = f.value(this._t + l.userData.phase, l.userData.speed);
      const amp = l.userData.flicker;
      l.intensity = l.userData.base * (1 - amp + amp * (0.45 + 1.15 * n));
    }
    // the wall wash breathes on the same smoothed noise — it is firelight and
    // sconce-light thrown up the masonry, not an architectural floodlight
    for(const s of this.washes){
      const on = this.params.wallWash !== false && !!s.userData.base;
      s.visible = on;
      if(!on){ s.intensity = 0; continue; }
      const f = s.userData.flick;
      const amp = s.userData.flicker || 0;
      const n = f ? f.value(this._t + s.userData.phase, s.userData.speed) : 0.5;
      s.intensity = s.userData.base * (1 - amp + amp * (0.45 + 1.15 * n));
    }
  }

  lateUpdate(alpha, ctx){
    this._followSubject(ctx);
    this.atmosphere?.lateUpdate?.(alpha, ctx);
    this.debugScene?.sync?.(ctx);
  }

  /**
   * Park the subject key on the hero. Runs per-frame (visuals only) and is
   * defensive about the player system: §6 of the architecture contract says any
   * system may be a stub, and a missing hero must simply leave the light where
   * it was rather than throw inside the render loop.
   */
  _followSubject(ctx){
    if(!this.subject) return;
    const on = this.params.subject !== false;
    this.subject.intensity = on ? (this.subject.userData.base ?? 0) : 0;
    if(!on) return;
    const p = ctx && ctx.player && (ctx.player.position || ctx.player.root?.position || ctx.player.group?.position);
    if(p && Number.isFinite(p.x)){
      // Smoothed, not snapped: a light that teleports with a dashing character
      // strobes the whole silhouette. This is a visual lag only — no sim state.
      this._subjectPos.lerp(p, 0.35);
    }
    this.subject.position.set(
      this._subjectPos.x + this.subjectOffset.x,
      this._subjectPos.y + this.subjectOffset.y,
      this._subjectPos.z + this.subjectOffset.z,
    );
  }

  resize(w, h, ctx){ this.atmosphere?.resize?.(w, h, ctx); }

  dispose(){
    this._envRT?.dispose?.();
    this._envTex?.dispose?.();
    this._pmrem?.dispose?.();
    this.atmosphere?.dispose?.();
    if(this.key) this.key.dispose?.();
  }
}
