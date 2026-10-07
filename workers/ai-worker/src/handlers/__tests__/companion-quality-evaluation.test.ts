import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQualityVerdicts, qualityCases } from "../../live-tests/quality-cases.ts";

test("全文评测不能把漏标准、伪造引文或无法解析的评审计为通过", () => {
  const fixture=qualityCases.find(c=>c.id==="newton-pair")!;
  const answer="两股相互作用力作用在不同对象，箱子自身的合力决定其运动。";
  const valid={verdicts:fixture.criteria.map(c=>({criterionId:c.id,pass:true,evidence:answer,reason:"符合参考事实"}))};
  assert.equal(parseQualityVerdicts(JSON.stringify(valid),answer,fixture).length,2);
  assert.throws(()=>parseQualityVerdicts("不是JSON",answer,fixture));
  assert.throws(()=>parseQualityVerdicts(JSON.stringify({verdicts:[valid.verdicts[0]]}),answer,fixture));
  assert.throws(()=>parseQualityVerdicts(JSON.stringify({verdicts:valid.verdicts.map(v=>({...v,evidence:"凭空编出的引文"}))}),answer,fixture));
  assert.throws(()=>parseQualityVerdicts(JSON.stringify({verdicts:[valid.verdicts[0],valid.verdicts[0]]}),answer,fixture));
});
