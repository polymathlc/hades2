# Boons, Upgrades & The Offer Screen

How EREBUS' boon systems map onto Supergiant's design in *Hades* and *Hades II*,
what changed in this pass, and where the seams are.

Owner: AGENT-UI. Data and modifier engine live in `src/game/`, presentation in
`src/ui/`. Combat never walks a list of boons — granting one rebuilds a flat
`mods` object that combat reads by property access.

---

## 1. What Hades actually does, and what we now do

Hades' boon system is four ideas layered on one another. Before this pass we had
one and a half of them; now we have all four.

| Hades' idea | Before | Now |
|---|---|---|
| A **grade ladder** you can be promoted along | Common/Rare/Epic/Heroic existed and scaled | Same ladder, plus two *fixed* grades — Duo and Legendary — that never roll and never promote |
| **Slots**: one boon per ability, and the offer knows which are free | Slots were exclusive, but offers ignored which were empty | `slotState()` / `freeSlots()` is the single source of truth; the draw is biased 72% toward categories you have not filled |
| **Prerequisites**: Duos and Legendaries are earned | Duo needed only "you met both gods" | Both now check the actual boons held, and report *what is missing* so the card can show it |
| **Two axes of power**: rarity is quality, Poms are potency | Levels existed but nothing granted them | Poms are a first-class API and a first-class card; rerolls are a real run currency |

---

## 2. Rarity: a ladder plus two fixed grades

```
RARITIES  = common → rare → epic → heroic        // rolls, promotes
FIXED_TIERS =                       duo, legendary // never rolls, never promotes
TIERS     = RARITIES ++ FIXED_TIERS
RARITY_MUL = 1 · 1.5 · 2.0 · 2.6 · duo 2.2 · legendary 3.0
```

Keeping the ladder at four is deliberate. `nextRarity()`, the replacement
promotion rule and the "an Epic slot is settled, do not offer sidegrades for it"
rule all walk that ladder; a Duo has no Rare version to be promoted from, so it
must not sit on it. `isFixedTier()` is the guard.

`offer()` forces the grade for the fixed tiers, so a Duo can never be handed to
the player as "Common Sea Storm". The scaled values follow automatically —
a Duo's authored `base` is written at Common like everything else and comes out
2.2× stronger, which is why Duos read as payoffs without a second value table.

Colour is authored once, in `src/ui/style.css`, as `--rarity-*` custom
properties, and read back by `ornament.js:bindRarityPalette()` — the same
discipline the type stack already used. Canvas ornament and any DOM chrome
cannot drift apart. Every grade also carries a **pip count** so grade survives
for a colour-blind player: the word is printed on the ribbon and the pips are
counted underneath.

## 3. Slots

`ACTION_SLOTS = attack · special · cast · dash · call`. Exactly one boon each.

- `slotState()` returns, for each category, whether it is filled, by what, at
  what grade and level, and whether that boon can still be promoted.
- `freeSlots()` drives the offer bias. Hades hands you a card for a category you
  cannot yet use far more often than a fifth sidegrade for one you can; without
  that bias a run degenerates into five Attack boons and an empty Cast.
- Taking a boon for an occupied action category still *transmutes*: the
  incoming card inherits the displaced boon's tier and advances one step, and
  the offer screen previews that before you commit (`REPLACES … / RARE → EPIC`).
- Epic and Heroic action slots are protected from different cards in the same
  category — a settled build should be offered promotions, not sidegrades.

## 4. Prerequisite gating

A Duo in Hades is "one of *these* boons from her AND one of *these* from him".
Hand-authoring 85 requirement lists would rot on the first content change, so
the list is **derived once, deterministically**, from what each god actually
offers: their action-slot boons form the prerequisite pool (passives are
excluded — a passive is a stat, not a commitment). A duo may still ship an
explicit `requires` map when a designer wants a tighter promise.

Legendaries use the same machinery with one god and `need: 2` — two distinct
qualifying boons from that patron. Fifteen are authored, one per major god, and
each does something the ordinary pool cannot (Splitting Bolt adds forks *and*
Blitz power; Nexus Sting makes Hitch share damage; Winter Harvest shatters).

`prerequisiteStatus(boon, heldIds)` returns a structured report:

```js
{ gated: true, met: false, need: 2,
  gods: [{ god: 'zeus', need: 2, have: 1, met: false, ownedNames: ['Lightning Strike'] }, …] }
```

That shape is what makes a gate *legible* — the offer card prints
`REQUIRES BOTH · ZEUS 1/1 · POSEIDON 0/1` with the satisfied half lit. A gate the
player cannot read is not a goal, it is noise. Locked cards never enter the
ordinary draw (`roll()` filters them, and the test suite asserts it across every
god and six run depths).

## 5. Poms of Power and rerolls

**Poms** move the potency axis only. `applyPom(id, n)` raises a held boon's
level and recomputes its values at the same rarity; a Common boon fed five Poms
out-damages a fresh Epic, exactly as in Hades. `pomOffers(rng, 3)` returns
offer-shaped objects with `kind: 'pom'`, so the same three-card screen renders
them, and `BoonOverlay.choose()` routes a Pom through `applyPom` rather than
`grant` so the grade is never silently rerolled. `ui.showPomChoice()` opens it.

**Rerolls** are Fated Persuasion. `BoonState.rerolls` is a run resource seeded
from a new Mirror talent (`fatedPersuasion`, max 4) inside `seedRun()`, which
`clear()` calls — so a new descent picks up the meta progression with no change
to the run system. `reroll()` spends a token and deals again while remembering
every id shown for the life of the offer, so **a reroll physically cannot return
the cards you just refused**. That is the property the feature lives or dies on
and it is asserted directly.

## 6. Status curses

Combat implements five primitives: `burn · chill · shock · doom · weak`. Hades II
speaks in *curses*, and a curse is more than a rename — it has its own name,
colour, verb and owning god. `CURSES` maps eight display curses onto those five
primitives:

| Curse | Engine | Gods |
|---|---|---|
| Scorch | burn | Hestia, Hephaestus |
| Hangover | burn | Dionysus (Hades I's own name for it) |
| Blitz | shock | Zeus |
| Freeze | chill | Demeter, Hecate, Selene |
| Slow | chill | Poseidon |
| Hitch | weak | Hera |
| Weak | weak | Aphrodite, Athena, Artemis |
| Blind | weak | Apollo |
| Wither | doom | Ares, Hades |

`engine` is the only field combat ever sees, so no combat change was needed:
riders still carry `status: 'weak'` while the card promises **Hitch** and the
tray shows a pink Hitch chip. Three gods share the `weak` primitive and none of
them share a name — the test asserts that, because collapsing them would undo
the whole point. Every status-bearing boon's advertised curse must resolve to
the status it actually applies; that is also asserted, across all 363 boons.

Descriptions were rewritten through the generators in `hades2-boons.js`,
`canonical-boons.js` and `boon-expansion.js` so the vocabulary is consistent
("inflicts 2 Blitz", not "inflicts Shock"). Those three modules are imported by
`boons.js`, so they carry the wording as a plain literal rather than closing an
import cycle; `boons.js` owns the semantics.

## 7. God identity

Every god now carries an `identity` line — one sentence stating what building
into them *is for* — shown under their name on the offer card and in the Codex.
Numbers alone do not make Poseidon feel different from Ares; "hurl foes into
walls and let the room finish them" versus "damage banked, then collected" does.
Each god's signature curse reinforces it.

---

## 8. The presentation

### The offer screen (`src/ui/boons.js`)
- **Rarity ribbon** across the head of every card. Grade stated first, in the
  grade's colour, with the level appended when a Pom has moved it.
- **God portrait** from the existing `god-portraits-v1` atlas (unchanged
  sampling, no new binary assets), in a rarity ring, with the emblem preserved
  as a small seal so the fast-read identity survives.
- **Slot glyph** — a sword, burst, shard, chevron or horn — beside the category
  pill and mirrored top-right, so "this replaces my Dash" is readable without
  reading.
- **Curse chip** in the curse's own colour, next to the slot pill.
- **Prerequisite callout** for gated cards: both patrons, with per-god
  `have/need` and the satisfied half lit.
- **Effect text** with numerals lifted into gold and every curse name painted in
  its curse colour.
- **Replacement preview** (kept from before): what this displaces, and the
  grade transition in words as well as colour.
- **Reroll affordance**: its own plaque under the row with a spinning glyph,
  remaining tokens as pips, `R` on keyboard, gamepad X, or click. Denial is a
  red flash, not silence.
- Fixed tiers (Duo, Legendary) take their edge light from the tier rather than
  the god, burn brighter, and label themselves `A DUO BOON` / `A LEGENDARY BOON`.

### The HUD tray (`src/ui/hud.js`, `src/ui/hud-boons.js`)
Was a column of unexplained god sigils. Now a **loadout**:
- The five ability categories are always present, in play order, **including
  empty ones** — "your Cast slot is still free" is the information a Hades
  player uses to choose at the next gate.
- Each row: hex sigil in the god's colour, category tag, the input binding
  (`LMB / RMB / Q / SPACE / R`), boon name, grade pips, and `LV n` when levelled.
- Rarity colours the row's border and a spine; pips repeat the grade so colour
  is never the only channel.
- Passives, Duos and Legendaries follow under a divider, and trimming sheds
  ordinary passives before it ever sheds a payoff card.
- **Hover any row for a tooltip** with the live description at the grade and
  level actually held, plus the curse chip and its blurb. Pointer hit-testing
  outside modals was added for exactly this.
- The tray measures the room it has and compresses rather than growing down
  into the combat cluster at small window sizes.

### The Codex (`src/ui/menus.js`)
- Grouped by ability category with headings, scroll window follows the
  selection, rarity spine per row, curse chip per row.
- Header states the build in one line: boons, gods, duos, legendaries, rerolls.
- Detail plate: grade ribbon in the same language as the offer card, god
  emblem, curse chip *with its blurb*, the live description (from `describe()`,
  so it prints the numbers actually in play — not the authored template), and
  the god's identity line.

### Combat readouts
The magick bar's label used to vanish against its own lit fill; it now sits on
a narrow ink plate and reads `64 /100` in the same grammar as the life bar. The
Cast and Dash meters carry their bindings (`CAST · Q`, `DASH · SPACE`), matching
the tray's legend so one vocabulary covers the whole HUD.

### Capture scenarios
`capture.state('payoff')` is a new reference shot: an earned Duo, an unearned
Legendary (so the prerequisite callout is exercised) and a Pom of Power — the
three cards the ordinary `boons` shot cannot show. `capture.state('loadout')`
now seeds a build with a Duo, a Legendary and a Pom-levelled boon so the Codex
shot exercises every grade it can render.

### Typography and small windows
`style.css` now carries the type scale, card geometry, rarity and curse palettes
as custom properties, with a small-viewport block that steps the scale and card
size down, plus a `prefers-reduced-motion` hook. The UI canvas already clamps
its own scale to `[0.62, 1.5]`; the tray and the offer row both fit 1024×576.

---

## 9. Integration points the run system may want

None are required — everything works through existing contracts. These are
optional one-liners for `src/game/run.js` (not owned by this pass):

```js
// hand out a Pom of Power as a chamber reward
await ctx.ui.showPomChoice();

// hand out Fated Persuasion (boss reward, shop, Chaos gate)
ctx.ui.grantRerolls(1);
```

`ctx.boons.seedRun()` is already invoked by `clear()`, so Mirror-seeded rerolls
arrive without a call site.

## 10. Tests

`npm run test:boons` is a real suite, not a smoke test. Beyond the pre-existing
combat integration checks (Doom knives, Chill duration, wall slams, every duo's
advertised payoff reaching combat) it now asserts:

1. every card has an id, a ≥3-character name, a known slot, an `apply()`, a base
   table, and a ≥12-character description at all four rolled grades with no
   `undefined`/`NaN` leaking through;
2. **rarity monotonicity** — no authored value ever shrinks as the grade
   improves, penalties deepen rather than flip sign, and every numeric boon
   actually responds to rarity (330+ of them);
3. **descriptions match computed values** — a Heroic card may never print its
   Common number, and every printed number must come from the scaled value
   table. This is the easiest bug to introduce when rarity multiplies values;
4. **no broken hands** — across all 17 gods × 6 run depths: no duplicate ids in
   an offer, every card renderable, no card from another pantheon, fixed tiers
   never rolling an ordinary grade, and no locked card ever offered;
5. **slot exclusivity** after granting every action boon in the game, plus
   `slotState()`/`freeSlots()` agreeing with it;
6. **the free-slot bias** actually biases (>70% of offers point at an unfilled
   category);
7. **duo gating**: passives alone do not unlock a duo, one god is not enough,
   the half-met state reports correctly, satisfying both unlocks it at Duo
   grade, and an owned duo leaves the pool;
8. **legendary gating**: one boon is not enough, two are, only for that god, and
   an unearned Legendary never enters the ordinary draw (20 rolls);
9. **Poms**: level rises, rarity does not, potency reaches the rider, stacking
   keeps mattering, and a Pom on an unheld boon is a no-op;
10. **rerolls**: refused with no tokens, costs exactly one, never returns a card
    from any previously shown hand, goes to zero and stops, and the Mirror seed
    is restored by a new descent;
11. **curses**: all map to primitives combat can apply, all are complete, every
    status-bearing boon's curse matches the status it applies, and gods sharing
    a primitive do not share a curse name;
12. **the loadout report** the Codex renders prints live values, level included;
13. **HUD tray grouping** obeys the same slot contract and carries enough text
    to render a tooltip without asking the engine.

`npm run test:meta` and `npm run build` also pass, as do `test:features`,
`test:weapons` and `test:textures`.
