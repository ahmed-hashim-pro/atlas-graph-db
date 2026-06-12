import { mulberry32 } from './random.js';

export interface DatasetNode {
  labels: string[];
  props: Record<string, string | number>;
}

export interface DatasetEdge {
  from: number; // index into nodes
  to: number;
  type: string;
  props?: Record<string, string | number>;
}

export interface DatasetGraph {
  nodes: DatasetNode[];
  edges: DatasetEdge[];
}

const PEOPLE: [name: string, born: number, field: string][] = [
  ['Ada Lovelace', 1815, 'mathematics'],
  ['Charles Babbage', 1791, 'mathematics'],
  ['Charles Darwin', 1809, 'biology'],
  ['Marie Curie', 1867, 'physics'],
  ['Pierre Curie', 1859, 'physics'],
  ['James Clerk Maxwell', 1831, 'physics'],
  ['Michael Faraday', 1791, 'physics'],
  ['Isaac Newton', 1643, 'physics'],
  ['Gottfried Leibniz', 1646, 'mathematics'],
  ['Leonhard Euler', 1707, 'mathematics'],
  ['Carl Friedrich Gauss', 1777, 'mathematics'],
  ['Mary Somerville', 1780, 'astronomy'],
  ['John Herschel', 1792, 'astronomy'],
  ['Gregor Mendel', 1822, 'biology'],
  ['Louis Pasteur', 1822, 'biology'],
  ['Dmitri Mendeleev', 1834, 'chemistry'],
  ['Antoine Lavoisier', 1743, 'chemistry'],
  ['Alan Turing', 1912, 'computer science'],
  ['Kurt Gödel', 1906, 'logic'],
  ['Emmy Noether', 1882, 'mathematics'],
  ['Bernhard Riemann', 1826, 'mathematics'],
  ['George Boole', 1815, 'logic'],
  ['Augusta De Morgan', 1806, 'logic'],
  ['Lise Meitner', 1878, 'physics'],
];

const CONCEPTS = [
  'Analytical Engine',
  'Natural Selection',
  'Radioactivity',
  'Electromagnetism',
  'Calculus',
  'Number Theory',
  'Computability',
  'Genetics',
  'Periodic Table',
  'Boolean Algebra',
  'Abstract Algebra',
  'Nuclear Fission',
];

const DOCUMENTS: [title: string, year: number, authorIdx: number][] = [
  ['Notes on the Analytical Engine', 1843, 0],
  ['On the Economy of Machinery', 1832, 1],
  ['On the Origin of Species', 1859, 2],
  ['Recherches sur les substances radioactives', 1903, 3],
  ['A Treatise on Electricity and Magnetism', 1873, 5],
  ['Experimental Researches in Electricity', 1839, 6],
  ['Philosophiæ Naturalis Principia Mathematica', 1687, 7],
  ['Disquisitiones Arithmeticae', 1801, 10],
  ['On the Connexion of the Physical Sciences', 1834, 11],
  ['Experiments on Plant Hybridization', 1866, 13],
  ['On the Periodic Law', 1869, 15],
  ['On Computable Numbers', 1936, 17],
  ['An Investigation of the Laws of Thought', 1854, 21],
  ['Idealtheorie in Ringbereichen', 1921, 19],
];

const PLACES = ['London', 'Paris', 'Cambridge', 'Edinburgh', 'Berlin', 'Vienna', 'Warsaw', 'Basel'];

const BORN_IN: [personIdx: number, placeIdx: number][] = [
  [0, 0],
  [1, 0],
  [3, 6],
  [4, 1],
  [6, 0],
  [7, 2],
  [9, 7],
  [11, 3],
  [18, 5],
  [19, 4],
];

const KNOWS: [number, number][] = [
  [0, 1],
  [0, 11],
  [0, 22],
  [1, 12],
  [1, 11],
  [3, 4],
  [5, 6],
  [21, 22],
  [13, 14],
  [23, 19],
];

const INFLUENCED: [fromIdx: number, toIdx: number][] = [
  [7, 9],
  [8, 9],
  [9, 10],
  [10, 20],
  [1, 0],
  [6, 5],
  [21, 18],
  [21, 17],
  [2, 13],
  [16, 15],
  [19, 20],
];

// Document -> Concept citations from the curated core.
const DOC_CITES_CONCEPT: [docIdx: number, conceptIdx: number][] = [
  [0, 0],
  [0, 6],
  [2, 1],
  [3, 2],
  [4, 3],
  [5, 3],
  [6, 4],
  [7, 5],
  [9, 7],
  [10, 8],
  [11, 6],
  [12, 9],
  [13, 10],
];

const TARGET_NODES = 500;

/**
 * Deterministic build: a curated core of real entities, expanded with
 * generated period documents (correspondence and lectures attributed to the
 * curated people, citing curated concepts/documents) up to exactly
 * TARGET_NODES nodes. Same output on every call.
 */
export function scienceHistory(): DatasetGraph {
  const nodes: DatasetNode[] = [];
  const edges: DatasetEdge[] = [];

  const personBase = nodes.length;
  for (const [name, born, field] of PEOPLE)
    nodes.push({ labels: ['Person'], props: { name, born, field } });
  const conceptBase = nodes.length;
  for (const name of CONCEPTS) nodes.push({ labels: ['Concept'], props: { name } });
  const docBase = nodes.length;
  for (const [title, year] of DOCUMENTS)
    nodes.push({ labels: ['Document'], props: { title, year } });
  const placeBase = nodes.length;
  for (const name of PLACES) nodes.push({ labels: ['Place'], props: { name } });

  for (const [d, [, , authorIdx]] of DOCUMENTS.entries())
    edges.push({ from: personBase + authorIdx, to: docBase + d, type: 'WROTE' });
  for (const [p, place] of BORN_IN)
    edges.push({ from: personBase + p, to: placeBase + place, type: 'BORN_IN' });
  for (const [a, b] of KNOWS)
    edges.push({ from: personBase + a, to: personBase + b, type: 'KNOWS' });
  for (const [a, b] of INFLUENCED)
    edges.push({ from: personBase + a, to: personBase + b, type: 'INFLUENCED' });
  for (const [d, c] of DOC_CITES_CONCEPT)
    edges.push({ from: docBase + d, to: conceptBase + c, type: 'CITES' });

  // Deterministic expansion: generated documents until TARGET_NODES.
  const rand = mulberry32(11);
  const pick = (n: number): number => Math.floor(rand() * n);
  let serial = 1;
  while (nodes.length < TARGET_NODES) {
    const author = pick(PEOPLE.length);
    const [authorName, authorBorn] = PEOPLE[author]!;
    const kind = rand() < 0.5 ? 'Letter' : 'Lecture';
    const concept = pick(CONCEPTS.length);
    const year = authorBorn + 25 + pick(35);
    const idx = nodes.length;
    nodes.push({
      labels: ['Document'],
      props: { title: `${kind} ${serial++} of ${authorName} on ${CONCEPTS[concept]!}`, year },
    });
    edges.push({ from: personBase + author, to: idx, type: 'WROTE' });
    edges.push({ from: idx, to: conceptBase + concept, type: 'CITES' });
    if (rand() < 0.6)
      edges.push({ from: idx, to: docBase + pick(DOCUMENTS.length), type: 'CITES' });
  }

  return { nodes, edges };
}
