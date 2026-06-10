export class Interner {
  private readonly byString = new Map<string, number>();
  private readonly byId: string[] = [];

  intern(s: string): number {
    const existing = this.byString.get(s);
    if (existing !== undefined) return existing;
    const id = this.byId.length;
    this.byString.set(s, id);
    this.byId.push(s);
    return id;
  }

  idOf(s: string): number | undefined {
    return this.byString.get(s);
  }

  stringOf(id: number): string {
    const s = this.byId[id];
    if (s === undefined) throw new RangeError(`unknown interned id ${id}`);
    return s;
  }
}
