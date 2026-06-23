import assert from "node:assert/strict";
import test from "node:test";

import { renderArtifactTemplate } from "../../../src/services/conductor/runtime/render-artifact-template.js";

test("renderArtifactTemplate substitutes ticket and customer variables", () => {
  const rendered = renderArtifactTemplate(
    {
      subject: "Re: {{ticket_subject}}",
      text: "Hi {{customer_name}}, thanks for reaching out about {{ticket_subject}}.",
      html: "<p>Hi {{customer_name}}</p>",
    },
    {
      ticket_subject: "Login bug",
      customer_name: "Alex",
    },
  );
  assert.equal(rendered.subject, "Re: Login bug");
  assert.match(rendered.body, /Hi Alex/);
  assert.match(rendered.body, /Login bug/);
  assert.equal(rendered.html, "<p>Hi Alex</p>");
});
