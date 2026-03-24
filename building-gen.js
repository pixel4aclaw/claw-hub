/**
 * Deterministic building generator — no LLM needed.
 * Given a username and an index (position in town), returns a building definition.
 */

const WORLD_CENTER_X = 2000;
const WORLD_CENTER_Y = 1500;

const ARCHETYPES = [
  { type: 'tower',       emoji: '🗼', color: '#7c3aed', label: 'Tower'       },
  { type: 'cottage',     emoji: '🏡', color: '#16a34a', label: 'Cottage'     },
  { type: 'library',     emoji: '📚', color: '#2563eb', label: 'Library'     },
  { type: 'forge',       emoji: '⚒️',  color: '#ea580c', label: 'Forge'       },
  { type: 'garden',      emoji: '🌿', color: '#65a30d', label: 'Garden'      },
  { type: 'observatory', emoji: '🔭', color: '#0891b2', label: 'Observatory' },
  { type: 'tavern',      emoji: '🍺', color: '#d97706', label: 'Tavern'      },
  { type: 'workshop',    emoji: '🔧', color: '#6b7280', label: 'Workshop'    },
  { type: 'lighthouse',  emoji: '💡', color: '#eab308', label: 'Lighthouse'  },
  { type: 'bakery',      emoji: '🥐', color: '#a16207', label: 'Bakery'      },
  { type: 'vault',       emoji: '🏦', color: '#475569', label: 'Vault'       },
  { type: 'greenhouse',  emoji: '🪴', color: '#4ade80', label: 'Greenhouse'  },
];

const DESCRIPTIONS = {
  tower:       u => `${cap(u)}'s tower rises into the mists, its windows glowing with strange purpose.`,
  cottage:     u => `A snug little cottage belonging to ${cap(u)}, with smoke curling from the chimney.`,
  library:     u => `${cap(u)}'s library holds knowledge both real and imagined. The door is always open.`,
  forge:       u => `Sparks fly day and night from ${cap(u)}'s forge. Something is always being built here.`,
  garden:      u => `${cap(u)}'s garden grows things that shouldn't exist in any season.`,
  observatory: u => `${cap(u)}'s observatory watches the sky and occasionally the neighbors.`,
  tavern:      u => `${cap(u)}'s tavern — deals are made, secrets shared, tabs rarely settled.`,
  workshop:    u => `${cap(u)}'s workshop is chaotic, brilliant, and always producing something new.`,
  lighthouse:  u => `${cap(u)}'s lighthouse guides wanderers in from the dark. Usually helpful.`,
  bakery:      u => `${cap(u)}'s bakery smells like it was baked in a different dimension entirely.`,
  vault:       u => `${cap(u)}'s vault. Nobody knows what's inside. ${cap(u)} might not either.`,
  greenhouse:  u => `${cap(u)}'s greenhouse hums with life. Some of it is definitely not from here.`,
};

function cap(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// djb2 hash — stable across runs
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function getArchetype(username) {
  return ARCHETYPES[hash(username) % ARCHETYPES.length];
}

// Golden-angle spiral placement. index=0 is closest to center.
function getPosition(index) {
  const angle = (index * 137.508) * (Math.PI / 180);
  const radius = 200 + index * 75;
  return {
    x: Math.round(WORLD_CENTER_X + radius * Math.cos(angle)),
    y: Math.round(WORLD_CENTER_Y + radius * Math.sin(angle)),
  };
}

/**
 * Returns { type, emoji, color, label, description, x, y }
 * index = number of existing buildings (used for placement)
 */
function generateBuilding(username, index) {
  const arch = getArchetype(username);
  const pos  = getPosition(index);
  return {
    type:        arch.type,
    emoji:       arch.emoji,
    color:       arch.color,
    label:       arch.label,
    description: DESCRIPTIONS[arch.type](username),
    x:           pos.x,
    y:           pos.y,
  };
}

/**
 * Enrich a DB building row with emoji/color/label derived from type.
 */
function enrichBuilding(row) {
  const arch = ARCHETYPES.find(a => a.type === row.type) || ARCHETYPES[0];
  return { ...row, emoji: arch.emoji, color: arch.color, label: arch.label };
}

module.exports = { generateBuilding, enrichBuilding, WORLD_CENTER_X, WORLD_CENTER_Y };
