export class IdAllocator {
  constructor(
    private nodeNext = 1,
    private edgeNext = 1,
  ) {}

  nextNode(): number {
    return this.nodeNext++;
  }

  nextEdge(): number {
    return this.edgeNext++;
  }

  peek(): { nodeNext: number; edgeNext: number } {
    return { nodeNext: this.nodeNext, edgeNext: this.edgeNext };
  }
}
