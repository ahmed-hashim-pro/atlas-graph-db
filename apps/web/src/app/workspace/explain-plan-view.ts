import { Component, input } from '@angular/core';
import type { PlanTreeRow } from './explain-plan';

@Component({
  selector: 'app-explain-plan-view',
  templateUrl: './explain-plan-view.html',
})
export class ExplainPlanView {
  readonly rows = input.required<PlanTreeRow[]>();
  indent(depth: number): string {
    return `${depth * 1.25}rem`;
  }
}
