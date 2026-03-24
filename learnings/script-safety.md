# Script Safety Rules

Rules every script MUST follow. Learned from failures.

## Before ANY Action
1. Check `sdk.getState()` is not null
2. Check `player.hp` — abort if below 30% max HP and no food
3. Check `player.combat.inCombat` — don't try to walk/bank while fighting
4. Check position makes sense (not 0,0 which means glitched)

## During Travel
- Monitor HP every few ticks during long walks
- If attacked unexpectedly, check if we can win. If not, keep running.
- Always carry 3-5 food when traveling between areas
- Know the route dangers BEFORE walking (see routes-and-dangers.md)

## During Combat
- Eat food when HP < 40% of max
- If no food left, LEAVE. Don't keep fighting.
- Track consecutive failures — if 5+ attacks fail, reposition
- Don't fight multiple enemies at Defence 1

## Banking
- Approach Draynor bank from the NORTH to avoid Dark Wizards
- Always close bank before walking away
- Verify deposits actually worked (check inventory after)

## Script Structure Template
```typescript
// 1. Check state
const state = sdk.getState();
if (!state || !state.player) return;

// 2. Safety checks
if (state.player.hp < state.player.maxHp * 0.3) {
    const food = sdk.findInventoryItem(/bread|meat|shrimp|trout/i);
    if (food) await bot.eatFood(food);
    else { console.log('LOW HP, NO FOOD — aborting'); return; }
}

// 3. Check if in combat before doing non-combat things
if (state.player.combat.inCombat) {
    await sdk.waitForTicks(5); // wait for combat to end
    continue;
}

// 4. Do the actual action
// ...
```

## What NOT To Do
- Don't run scripts blindly without watching output
- Don't assume walks will succeed — check position after
- Don't assume bank will open — check result
- Don't travel with no food at low HP
- Don't write 30-minute scripts that can't adapt to problems
