//writes a made-up shop as three csv files: customers, products and orders. the
//same seed always gives the same files, so the examples in the readme and the
//numbers in the benchmark can be reproduced.
//
//  node scripts/generate-data.js <directory> [orders] [customers] [products]

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIRST = [
  'Ada',
  'Alan',
  'Amara',
  'Barbara',
  'Chen',
  'Dev',
  'Edsger',
  'Fatima',
  'Grace',
  'Hana',
];
const MORE_FIRST = [
  'Ines',
  'Jonas',
  'Katya',
  'Liam',
  'Mei',
  'Noor',
  'Oscar',
  'Priya',
  'Rosa',
  'Tom',
];
const LAST = [
  'Okafor',
  'Walsh',
  'Novak',
  'Haddad',
  'Lindqvist',
  'Moreau',
  'Byrne',
  'Rossi',
  'Tanaka',
];
const MORE_LAST = ['Schmidt', 'Patel', 'Garcia', 'de Vries', 'Kowalski', 'Murphy', 'Larsen', 'Ito'];
const COUNTRIES = [
  'United Kingdom',
  'United Kingdom',
  'United Kingdom',
  'Ireland',
  'France',
  'Germany',
];
const MORE_COUNTRIES = ['Germany', 'Spain', 'Netherlands', 'Sweden', 'Italy'];
const ADJECTIVES = [
  'Walnut',
  'Steel',
  'Linen',
  'Copper',
  'Glass',
  'Oak',
  'Ceramic',
  'Canvas',
  'Brass',
];
const NOUNS = {
  Kitchen: ['Kettle', 'Chopping Board', 'Teapot', 'Jug'],
  Office: ['Desk', 'Bookshelf', 'Monitor Stand', 'Notebook'],
  Outdoor: ['Lantern', 'Bench', 'Planter', 'Hammock'],
  Lighting: ['Floor Lamp', 'Pendant', 'Reading Light'],
  Audio: ['Speaker', 'Headphones', 'Turntable'],
};
const STATUSES = ['delivered', 'delivered', 'delivered', 'delivered', 'delivered', 'delivered'];
const MORE_STATUSES = ['delivered', 'shipped', 'pending', 'cancelled'];

const DAY = 24 * 60 * 60 * 1000;
const isoDate = (time) => new Date(time).toISOString().slice(0, 10);

//mulberry32: small, fast and the same on every machine
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

//writes a file a block of lines at a time, so a million rows are never all
//held as one string
function writeCsv(path, header, count, makeRow) {
  const file = openSync(path, 'w');
  let block = `${header}\n`;
  for (let index = 1; index <= count; index++) {
    block += `${makeRow(index).join(',')}\n`;
    if (index % 10000 === 0 || index === count) {
      writeSync(file, block);
      block = '';
    }
  }
  if (block !== '') writeSync(file, block);
  closeSync(file);
}

//generates the three files into a directory, creating it if need be
export function generateData(directory, sizes = {}) {
  const { orders = 2000, customers = 300, products = 40, seed = 2026 } = sizes;
  const random = createRandom(seed);
  const pick = (...lists) => {
    const items = lists.flat();
    return items[Math.floor(random() * items.length)];
  };
  mkdirSync(directory, { recursive: true });

  const start = Date.UTC(2023, 0, 1);
  writeCsv(
    join(directory, 'customers.csv'),
    'id,name,country,joined,newsletter',
    customers,
    (id) => [
      id,
      `${pick(FIRST, MORE_FIRST)} ${pick(LAST, MORE_LAST)}`,
      pick(COUNTRIES, MORE_COUNTRIES),
      isoDate(start + Math.floor(random() * 1000) * DAY),
      random() < 0.6,
    ],
  );

  const categories = Object.keys(NOUNS);
  writeCsv(join(directory, 'products.csv'), 'id,name,category,price', products, (id) => {
    const category = pick(categories);
    const price = (Math.floor(random() * 380) + 4).toFixed(0) + pick(['.00', '.50', '.99']);
    return [id, `${pick(ADJECTIVES)} ${pick(NOUNS[category])}`, category, price];
  });

  const opened = Date.UTC(2025, 0, 1);
  const header = 'id,customer_id,product_id,quantity,status,ordered_on,shipped_on';
  writeCsv(join(directory, 'orders.csv'), header, orders, (id) => {
    const status = pick(STATUSES, MORE_STATUSES);
    const orderedOn = opened + Math.floor(random() * 660) * DAY;
    const wasSent = status === 'delivered' || status === 'shipped';
    return [
      id,
      //squaring the draw makes some customers order far more than others
      Math.floor(random() ** 2 * customers) + 1,
      Math.floor(random() * products) + 1,
      Math.floor(random() ** 3 * 5) + 1,
      status,
      isoDate(orderedOn),
      wasSent ? isoDate(orderedOn + (1 + Math.floor(random() * 6)) * DAY) : '',
    ];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory, orders, customers, products] = process.argv.slice(2);
  if (directory === undefined) {
    console.error(
      'usage: node scripts/generate-data.js <directory> [orders] [customers] [products]',
    );
    process.exit(2);
  }
  const given = { orders, customers, products };
  const sizes = Object.fromEntries(
    Object.entries(given)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name, Number(value)]),
  );
  generateData(directory, sizes);
  console.log(`wrote customers.csv, products.csv and orders.csv to ${directory}`);
}
