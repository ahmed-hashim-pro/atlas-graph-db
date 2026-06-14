import { Component, input } from '@angular/core';
import { formatCell } from './cell-format';

@Component({
  selector: 'app-results-table',
  templateUrl: './results-table.html',
})
export class ResultsTable {
  readonly columns = input.required<string[]>();
  readonly rows = input.required<unknown[][]>();
  readonly fmt = formatCell;
}
