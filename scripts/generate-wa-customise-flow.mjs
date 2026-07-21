#!/usr/bin/env node
/**
 * Generate the WhatsApp "Customise item" Flow JSON with N radio-group slots.
 *
 * WHY: the bot opens a native Flow form (pick every option, one "Add to cart")
 * for items whose modifier groups all fit the published Flow's radio slots.
 * The original Flow had 5 slots (g0..g4), so a 4-group item (Solo Meal) got the
 * form but an 8-group item (Duet Meal) / 12-group item (Mega Meal) fell back to
 * the step-by-step chat wizard. Republishing the Flow with more slots + setting
 * WHATSAPP_FLOW_SLOTS to match makes the big meal deals open as one form too.
 *
 * The data contract MUST match buildFlowData()/handleFlowReply() in
 * apps/api/src/modules/whatsapp/whatsapp-ai.service.ts:
 *   data:    item_id, subtitle, notes_visible, gN_{visible,label,required,options}
 *   payload: { item_id, g0..g(N-1), notes }
 *
 * Usage:
 *   node scripts/generate-wa-customise-flow.mjs [slots]      # default 12
 *   node scripts/generate-wa-customise-flow.mjs 12 > flow.json
 *
 * Then in WhatsApp Manager → Flows → (your "Customise item" Flow) → Edit →
 * paste this JSON → Save → Publish. The Flow ID is unchanged. Finally set
 * Render env WHATSAPP_FLOW_SLOTS to the same number and redeploy the API.
 */

const slots = Math.max(1, Math.min(12, parseInt(process.argv[2] || "12", 10) || 12));

const data = {
  item_id: { type: "string", __example__: "item_1" },
  subtitle: { type: "string", __example__: "Choose your options" },
  notes_visible: { type: "boolean", __example__: true },
};
for (let i = 0; i < slots; i++) {
  data[`g${i}_visible`] = { type: "boolean", __example__: i === 0 };
  data[`g${i}_label`] = { type: "string", __example__: `Choice ${i + 1}` };
  data[`g${i}_required`] = { type: "boolean", __example__: false };
  data[`g${i}_options`] = {
    type: "array",
    items: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" } },
    },
    __example__: [{ id: "opt_a", title: "Option A" }],
  };
}

const formChildren = [];
for (let i = 0; i < slots; i++) {
  formChildren.push({
    type: "RadioButtonsGroup",
    name: `g${i}`,
    label: `\${data.g${i}_label}`,
    "data-source": `\${data.g${i}_options}`,
    required: `\${data.g${i}_required}`,
    visible: `\${data.g${i}_visible}`,
  });
}
formChildren.push({
  type: "TextInput",
  name: "notes",
  label: "Notes (optional)",
  required: false,
  visible: "${data.notes_visible}",
});

// Footer payload: item_id from screen data + every group + notes from the form.
const payload = { item_id: "${data.item_id}", notes: "${form.notes}" };
for (let i = 0; i < slots; i++) payload[`g${i}`] = `\${form.g${i}}`;

formChildren.push({
  type: "Footer",
  label: "Add to cart",
  "on-click-action": { name: "complete", payload },
});

const flow = {
  version: "7.0",
  screens: [
    {
      id: "CUSTOMISE",
      title: "Customise",
      terminal: true,
      data,
      layout: {
        type: "SingleColumnLayout",
        children: [
          { type: "TextSubheading", text: "${data.subtitle}" },
          { type: "Form", name: "customise_form", children: formChildren },
        ],
      },
    },
  ],
};

process.stdout.write(JSON.stringify(flow, null, 2) + "\n");
