//a small pair of tables used by the query tests. they are chosen to have the
//awkward cases in them: nulls in every kind of column, an order for a person
//who does not exist, and people with no orders.

import { Database } from '../../src/index.js';
import { tempDir } from './files.js';

export const PEOPLE = `id,name,city,age,member
1,Ada,London,36,true
2,Grace,New York,45,false
3,Alan,London,41,true
4,Edsger,Rotterdam,,false
5,Barbara,,28,true
`;

export const ORDERS = `id,person_id,item,amount
100,1,book,12.5
101,1,pen,1.25
102,3,book,20
103,3,laptop,999.99
104,9,ghost,5
105,2,pen,
`;

//a database over a fresh directory holding the two tables and any extra files
export async function shop(t, { files = {}, ...options } = {}) {
  const dir = await tempDir(t, { 'people.csv': PEOPLE, 'orders.csv': ORDERS, ...files });
  return new Database({ dir, ...options });
}
