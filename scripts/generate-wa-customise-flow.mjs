#!/usr/bin/env node
/**
 * Generate the WhatsApp "Customise item" Flow JSON with N option-group slots.
 *
 * WHY: the bot opens a native Flow form (pick every option, one "Add to cart")
 * for items whose modifier groups all fit the published Flow's radio slots.
 * The original Flow had 5 slots (g0..g4), so a 4-group item (Solo Meal) got the
 * form but an 8-group item (Duet Meal) / 12-group item (Mega Meal) fell back to
 * the step-by-step chat wizard. Republishing the Flow with more slots + setting
 * WHATSAPP_FLOW_SLOTS to match makes the big meal deals open as one form too.
 *
 * Each slot carries BOTH a radio and a checkbox component, because a Flow's
 * layout is fixed at publish time and the group in slot i might be pick-one on
 * one item and pick-many on the next. buildFlowData shows exactly one of the
 * pair per occupied slot; the other stays hidden. That is what lets an item
 * with a "choose as many toppings as you like" group open as the native form
 * instead of falling back to the chat wizard.
 *
 * The data contract MUST match buildFlowData()/handleFlowReply() in
 * apps/api/src/modules/whatsapp/whatsapp-ai.service.ts:
 *   data:    item_id, subtitle, notes_visible,
 *            gN_{visible,label,required,options}   ← radio  (pick one)
 *            cN_{visible,label,required,options}   ← checkbox (pick many)
 *   payload: { item_id, g0..g(N-1), c0..c(N-1), notes }
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
  data[`c${i}_visible`] = { type: "boolean", __example__: false };
  data[`c${i}_label`] = { type: "string", __example__: `Extras ${i + 1}` };
  data[`c${i}_required`] = { type: "boolean", __example__: false };
  data[`c${i}_options`] = {
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
  // The pick-many twin for the same slot. Deliberately no min/max-selected-
  // items: those would have to be data-bound numbers, which isn't a binding
  // this Flow has ever proven, and a Flow that fails to publish is worse than
  // one that lets someone tick a fourth topping. addToCart validates the ids
  // server-side either way.
  formChildren.push({
    type: "CheckboxGroup",
    name: `c${i}`,
    label: `\${data.c${i}_label}`,
    "data-source": `\${data.c${i}_options}`,
    required: `\${data.c${i}_required}`,
    visible: `\${data.c${i}_visible}`,
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
for (let i = 0; i < slots; i++) {
  payload[`g${i}`] = `\${form.g${i}}`;
  payload[`c${i}`] = `\${form.c${i}}`;
}

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
