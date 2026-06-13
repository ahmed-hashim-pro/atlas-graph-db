import { describe, expect, it } from 'vitest';
import { parseEdgesCsv, parseNodesCsv } from '../src/csv.js';

describe('parseNodesCsv', () => {
  it('parses typed headers into nodes with a tempId column', () => {
    const csv = 'tempId,:label,name:string,born:number,active:boolean\n1,Person,Ada,1815,true\n2,Person,Charles,1791,false';
    const nodes = parseNodesCsv(csv);
    expect(nodes).toEqual([
      { tempId: '1', labels: ['Person'], properties: { name: 'Ada', born: 1815, active: true } },
      { tempId: '2', labels: ['Person'], properties: { name: 'Charles', born: 1791, active: false } },
    ]);
  });

  it('supports multi-label (label split on |) and skips blank cells', () => {
    const csv = 'tempId,:label,name:string\n1,Person|Author,Ada\n2,Person,';
    const nodes = parseNodesCsv(csv);
    expect(nodes[0]!.labels).toEqual(['Person', 'Author']);
    expect(nodes[1]!.properties).toEqual({}); // blank name omitted
  });

  it('quotes: handles commas and escaped quotes inside quoted fields', () => {
    const csv = 'tempId,:label,title:string\n1,Doc,"Notes, vol. 1"\n2,Doc,"She said ""hi"""';
    const nodes = parseNodesCsv(csv);
    expect(nodes[0]!.properties.title).toBe('Notes, vol. 1');
    expect(nodes[1]!.properties.title).toBe('She said "hi"');
  });

  it('throws on a bad number cell or missing :label column', () => {
    expect(() => parseNodesCsv('tempId,:label,born:number\n1,P,notanumber')).toThrow();
    expect(() => parseNodesCsv('tempId,name:string\n1,Ada')).toThrow(/label/);
  });
});

describe('parseEdgesCsv', () => {
  it('parses :from/:to/:type plus typed props', () => {
    const csv = ':from,:to,:type,weight:number\n1,2,KNOWS,5\n2,3,WROTE,';
    expect(parseEdgesCsv(csv)).toEqual([
      { from: '1', to: '2', type: 'KNOWS', properties: { weight: 5 } },
      { from: '2', to: '3', type: 'WROTE', properties: {} },
    ]);
  });

  it('throws when required columns are missing', () => {
    expect(() => parseEdgesCsv(':from,:to,weight:number\n1,2,5')).toThrow(/type/);
  });
});
