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
| **Two axes of power**: rarity is quality, Poms are potency | Levels existed but nothing granted them | Poms and rerolls are dropped by every regional boss and spent at the next audience — `run.js` calls both |

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

**The pool is a SHORT list, not the whole family.** "Hold any one of Zeus'
thirteen action boons" is barely a gate. The eight authored duos name their
prerequisites outright (`requires: { zeus: [...3 ids], poseidon: [...] }`), and
the ~77 generated pairs take a deterministic five-id slice of each god's action
family, keyed by the duo's own id — so every duo asks for a different short
list, the list is identical in every run and on every machine, and it still
cannot rot when content is added. Simulated over 400 runs × 16 gates, 34% of
runs are offered at least one Duo and 16% at least one Legendary.

Legendaries use the same machinery with one god and `need: 2` — two distinct
qualifying boons from that patron. Fifteen are authored, one per major god, and
each does something the ordinary pool cannot (Splitting Bolt adds forks *and*
a flat rider on every Blitz discharge; Nexus Sting makes Hitch share damage
between afflicted foes; Winter Harvest shatters).

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
`grant` so the grade is never silently rerolled.

**They are reachable.** A Pom is a *currency* (`grantPoms` / `spendPom`), and
`run.js` both mints and spends it: every regional boss drops one Pom and one
Fated Persuasion token, and `_claimBoon()` checks the bank before it rolls a
god's hand — if a Pom is held, that gate's audience becomes the Pom screen
(`ui.showPomChoice({ offers })`, dealt from the run's own deterministic
stream). One modal per gate: a Pom is a reward, not a second interruption. The
Pom hand hides the reroll plaque, because Fated Persuasion has nothing to deal
from — the cards are the player's own boons.

**Rerolls** are Fated Persuasion. `BoonState.rerolls` is a run resource seeded
from a new Mirror talent (`fatedPersuasion`, max 4) inside `seedRun()`, which
`clear()` calls, and topped up by every boss. `reroll()` spends a token and
deals again while remembering every id shown for the life of the offer, so **a
reroll physically cannot return the cards you just refused**.

**A reroll deals from the same gate.** `BoonOverlay.open(options, o)` stores `o`
verbatim as `_rollOpts` and replays it, so whatever the run system passes to
`showBoonChoice` *is* the reroll. It used to be handed `{ upgradeChance: 0.58 }`
alone — no god, no weapon, no character — which meant a reroll at a Zeus gate
dealt Hera and Apollo cards, offered boons for arms the player was not holding,
and lost the Hephaestus forge-gate triplet entirely. `run.js` now builds ONE
`rollOpts` object and hands the same reference to `roll()` and to
`showBoonChoice()`; `test:boons` asserts both the runtime property (every card
in four consecutive rerolled hands belongs to the gate's god and the held arm,
and the forge gate keeps its attack/special/cast shape) and the source-level
one, because that drift is invisible until a player presses R.

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

A curse is no longer only a name. `rebuild()` stamps the owning boon's curse
onto the slot rider (`curse`, `curseColor`), `applyStatus()` reads it through
the rider that owns the hit, and the affliction record carries it — so an Apollo
Blind throws **gold** wisps and a Hera Hitch **pink** ones, instead of all three
`weak` curses throwing the engine's teal. The mechanics diverge too, from one
small table in `combat.js` (`WEAK_CURSE`): Hera *binds* (the foe's step drags,
through `slowOf`), Apollo *dazzles* (the foe never sees the blow coming — it
takes more damage), and Aphrodite/Athena/Artemis' plain Weak is the unmodified
sap. Three gods share the primitive, none share a name, and none share a
behaviour — all three are asserted. Every status-bearing boon's advertised curse must resolve to
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

## 8. The modifier contract: no write-only fields

`emptyMods()` is the whole vocabulary between the boon data and the engine. A
field written by a card and read by nobody is the worst bug this system can
have, because it is invisible: the card prints "Gain 1 additional Dash", the
run grants it, the tray shows it, and nothing happens. Ten such fields shipped
in the first pass. All ten now have a consumer:

| field | who reads it | what the card promised |
|---|---|---|
| `chainBonus` | `combat._statusTick` | a flat rider on every Blitz discharge |
| `slamAmp` | `combat._tryWallSlam` | wall slams hit harder |
| `roomDeflect` | `combat` on `room.entered` | each chamber begins with a Deflect |
| `vsWeakAmp` | `combat.applyDamage` | cursed foes take more from every source |
| `doomEscalate` | `combat._statusTick` (doom) | each Wither out-damages the last, ×5 |
| `markPermanent` | `combat.update` | Critical marks never expire |
| `dashCharges` | `player.update` / `_startDash` | one additional Dash (and a second HUD pip) |
| `hitchShare` | `combat.applyDamage` | Hitched foes bleed together |
| `scorchCap` | `combat.applyStatus` | Scorch stacks past its ceiling |
| `blastCinder` | `combat.projectileHit` | a forged Blast leaves burning cinders |

`mods.status[kind]` — every "your signature curse bites harder" boon, roughly
half of each god's list — was also inert: `applyStatus` read `statusDuration`
and never `status`. It was folded into the rider's stack count inside
`rebuild()`, which reached exactly one of the many ways a status is applied and
silently missed blasts, forks, calls and pulses. The fold is gone;
`applyStatus()` is now the single authority and scales every path once.

**The test that would have caught all of it.** `test:boons` derives the
consumer set by scanning every module outside the boon data for property access
on a modifier object (`mods.x`, `playerMods?.x`, `ctx.boons?.mods?.x`, plus
`BoonState._syncPlayer`'s own body), then asserts that (a) no field in
`emptyMods()` is unread, and (b) every key each of the 363 boons, 85 duos and
15 Legendaries writes — including keys it *invents* — is in that set. The set is
derived rather than listed so it keeps working as fields are added, and it is
what makes "the card prints an effect that never happens" a build failure.

## 9. The presentation

### The offer screen (`src/ui/boons.js`)
- **Rarity ribbon** across the head of every card. Grade stated first, with the
  level appended when a Pom has moved it. The tier owns the *plate* (a deep ink
  of its own hue), the rule under the word and the stroke; the word itself is
  the tier's light value on that ink. The first version painted tier-coloured
  text on a wash of the same hue and measured **1.4:1** on a Duo — the least
  legible text on the card, on the line the card exists to state. It now
  measures 7-12:1 on every grade.
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
- **A Duo shows both patrons**: the medallion is split down its centre with one
  god's portrait in each half, the name line reads `ZEUS + POSEIDON`, and both
  emblems are sealed beneath. The slot pill went back to naming the real slot —
  "DUO" was already the ribbon, the epithet and the edge light, and a fourth
  repetition cost the player the one fact the pill is there to carry.
- **A sealed card cannot be taken.** A gated card is worth showing (the gate is
  a goal), so it is dimmed, veiled, strapped `SEALED`, refuses hover lift, and
  `choose()` denies it with the same red flash a refused reroll gets.
- An `EPIC → EPIC` arrow is not a transition: a re-offer at a settled grade
  prints `EPIC · LV 2 → LV 3`, or `EPIC · AT ITS PEAK`.

### The HUD tray (`src/ui/hud.js`, `src/ui/hud-boons.js`)
Was a column of unexplained god sigils. Now a **loadout**:
- The five ability categories are always present, in play order, **including
  empty ones** — "your Cast slot is still free" is the information a Hades
  player uses to choose at the next gate. (Before the *first* boon of a descent
  the tray is five empty sockets and nothing else, which is noise, so it shows
  one quiet `LOADOUT · NO BOONS YET` line instead.)
- The whole column stands on a **scrim** that fades out to the right. Without
  it the empty sockets and their bindings — dashed bronze on a 2% fill — simply
  vanished over the lit floor of Tartarus, taking the legend with them.
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
weapon caption (`ZAGREUS · STYGIAN BLADE`) moved *below* that row — it had been
laid across the bar since long before this pass, and the new opaque ink plate
turned a faint overlap into a collision. The Cast and Dash meters carry their
bindings (`CAST · Q`, `DASH · SPACE`), and the Dash meter reads the hero's real
charge budget, so "gain 1 additional Dash" is a visible second pip.

### Capture scenarios
`capture.state('payoff')` is a new reference shot: an earned Duo, an unearned
Legendary (so the prerequisite callout is exercised) and a Pom of Power — the
three cards the ordinary `boons` shot cannot show. `capture.state('loadout')`
now seeds a build with a Duo, a Legendary and a Pom-levelled boon so the Codex
shot exercises every grade it can render.

### Typography, tokens and small windows
Every custom property in `style.css` is **read back by JS**; the ones that were
not are gone. What is bound: `--ui-display` / `--ui-body` (`displayFont()`),
`--rarity-*` (`bindRarityPalette()`), `--curse-*` (bound onto `CURSES`, so the
sheet colours the wisps as well as the chip), `--card-w/h/gap`
(`cardMetrics()`, which the offer row lays itself out from — including the
small-viewport step, which is why the cache is invalidated on resize rather
than read once at boot) and `--ui-motion` (`uiMotion()`, which the offer screen
and HUD multiply every deal-in stagger, specular sweep and spin by, so
`prefers-reduced-motion` parks the motion and keeps the information). The
`--type-*` ladder and the frozen `TYPE` literal beside it were deleted: nothing
read them, and a token nothing reads is a comment that lies. The UI canvas
clamps its own scale to `[0.62, 1.5]`; the tray and the offer row both fit
1024×576.

---

## 10. Where the run system calls in

Everything below is live in `src/game/run.js`, not a suggestion:

```js
// every gate: ONE options object, rolled with and rerolled from
const rollOpts = { count: 3, god, weapon, character, allowDuo: true, upgradeChance: 0.58 };
const offers = state.roll(rng, rollOpts);
await ctx.ui.showBoonChoice(offers, rollOpts);

// a banked Pom is spent at the next audience, before the god's hand is rolled
if (state.poms > 0 && state.pomTargets().length) await this._claimPom(state, rng);

// every regional boss mints both currencies
ctx.boons.grantPoms(1); ctx.boons.grantRerolls(1);
```

`ctx.boons.seedRun()` is invoked by `clear()`, so Mirror-seeded rerolls still
arrive with no call site at all.

## 11. Tests

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
    to render a tooltip without asking the engine;
14. **no write-only modifiers** — §8, the derived consumer scan, plus the ten
    Legendary payoffs asserted one by one *through combat* (a Weak foe really
    does take 40% more, Scorch really does pass its ceiling, the second Wither
    really does out-damage the first, a Hitched foe really does bleed onto its
    neighbour) rather than by inspecting `mods`;
15. **a reroll deals from the same gate** — god, arm and forge shape held
    across four consecutive rerolls, and `run.js` shown to pass the object it
    rolled with;
16. **curses differ in combat** — a Hitch and a Blind carry different colours,
    and only one of them drags;
17. **the gate, end to end** — the real `RunState._claimBoon` / `_onBossDefeated`
    driven against a stub context: a boss mints a Pom and a reroll, the next
    gate spends the Pom on a real level, and the gate after that is an ordinary
    audience again.

`npm run test:meta` and `npm run build` also pass, as do `test:features`,
`test:weapons` and `test:textures`.
