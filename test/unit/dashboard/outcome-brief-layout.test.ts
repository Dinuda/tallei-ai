import assert from "node:assert/strict";
import test from "node:test";

const { routeNodePosition, buildCanvasModel, routeCanvasHeight } = await import(
  "../../../dashboard/src/components/conductor/outcome-brief-layout.ts"
);

test("routeNodePosition snakes rows so the second row flows right to left", () => {
  assert.deepEqual(routeNodePosition(0, 6), { x: 0, y: 0, outputSide: "right" });
  assert.deepEqual(routeNodePosition(2, 6), { x: 540, y: 0, inputSide: "left", outputSide: "bottom" });
  assert.deepEqual(routeNodePosition(3, 6), { x: 540, y: 150, inputSide: "top", outputSide: "left" });
  assert.deepEqual(routeNodePosition(5, 6), { x: 0, y: 150, inputSide: "right" });
});

test("routeNodePosition keeps short routes on one row", () => {
  assert.deepEqual(routeNodePosition(0, 3), { x: 0, y: 0, outputSide: "right" });
  assert.deepEqual(routeNodePosition(2, 3), { x: 540, y: 0, inputSide: "left" });
});

test("routeNodePosition alternates direction every row for nine steps", () => {
  const positions = Array.from({ length: 9 }, (_, index) => routeNodePosition(index, 9));

  assert.deepEqual(positions.map((position) => position.x), [0, 270, 540, 540, 270, 0, 0, 270, 540]);
  assert.deepEqual(positions.map((position) => position.y), [0, 0, 0, 150, 150, 150, 300, 300, 300]);
  assert.equal(positions[2]?.outputSide, "bottom");
  assert.equal(positions[3]?.inputSide, "top");
  assert.equal(positions[3]?.outputSide, "left");
  assert.equal(positions[5]?.outputSide, "bottom");
  assert.equal(positions[6]?.inputSide, "top");
  assert.equal(positions[6]?.outputSide, "right");
  assert.equal(positions[7]?.outputSide, "right");
});

test("routeCanvasHeight grows with additional wrapped rows", () => {
  assert.equal(routeCanvasHeight(3), 300);
  assert.equal(routeCanvasHeight(6), 360);
  assert.equal(routeCanvasHeight(9), 430);
});

test("buildCanvasModel assigns wrapped positions and row-wrap handles", () => {
  const stages = Array.from({ length: 6 }, (_, index) => ({
    kind: "action" as const,
    identity: `Stage ${index + 1}`,
    label: `Step ${index + 1}`,
    description: `Description ${index + 1}`,
  }));
  const { nodes, edges } = buildCanvasModel(stages);

  assert.equal(nodes.length, 6);
  assert.equal(edges.length, 5);
  assert.deepEqual(nodes[2]?.position, { x: 540, y: 0 });
  assert.deepEqual(nodes[3]?.position, { x: 540, y: 150 });
  assert.equal(nodes[2]?.data.outputSide, "bottom");
  assert.equal(nodes[3]?.data.inputSide, "top");
  assert.equal(nodes[3]?.data.outputSide, "left");
  assert.equal(nodes[4]?.data.inputSide, "right");
  assert.equal(nodes[4]?.data.outputSide, "left");
});
