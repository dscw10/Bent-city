import * as THREE from 'three';
import { Builder } from './builder';
import { addBent } from './materials';

/**
 * A rebuilt-every-frame geometry buffer for things that MOVE: traffic,
 * pedestrians, rival couriers, countdown rings, the route ribbon.
 *
 * Why they cannot simply be moved with a transform: every vertex carries an
 * ANCHOR telling the shader which bit of hillside to lift it onto, and that
 * anchor is baked into the attribute at build time. Move the mesh and the
 * anchors are stale, so the object floats above or sinks into the ground.
 *
 * So the geometry is re-authored in world coordinates each frame. To keep that
 * free of garbage, the attribute arrays are allocated once at capacity and
 * written in place, with setDrawRange trimming to whatever was actually used.
 * Rebuilding a few thousand triangles per frame costs far less than the GC
 * churn of throwing away a BufferGeometry sixty times a second.
 */
export class MarkerBatch {
  readonly builder = new Builder();
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly pos: THREE.Float32BufferAttribute;
  private readonly nrm: THREE.Float32BufferAttribute;
  private readonly col: THREE.Float32BufferAttribute;
  private readonly anc: THREE.Float32BufferAttribute;
  private readonly capacity: number;
  private overflowed = false;

  constructor(scene: THREE.Scene, material: THREE.Material, capacity: number, renderOrder = 0) {
    this.capacity = capacity;
    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
    this.nrm = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
    this.col = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
    this.anc = new THREE.Float32BufferAttribute(new Float32Array(capacity * 2), 2);
    for (const a of [this.pos, this.nrm, this.col, this.anc]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('normal', this.nrm);
    this.geo.setAttribute('color', this.col);
    this.geo.setAttribute('aAnchor', this.anc);
    this.geo.setDrawRange(0, 0);

    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.renderOrder = renderOrder;
    addBent(scene, this.mesh);
  }

  /** Clear the builder, keeping its array capacity so nothing is reallocated. */
  begin(): Builder {
    const b = this.builder;
    b.p.length = 0; b.n.length = 0; b.c.length = 0; b.a.length = 0;
    return b;
  }

  /** Upload whatever was written and trim the draw range to it. */
  end(): void {
    const b = this.builder;
    let count = b.p.length / 3;

    if (count > this.capacity) {
      // Truncate to a whole triangle rather than dropping the frame — a couple
      // of missing markers beats a corrupt buffer or a stall.
      count = this.capacity - (this.capacity % 3);
      if (!this.overflowed) {
        this.overflowed = true;
        console.warn(`MarkerBatch over capacity (${b.p.length / 3} > ${this.capacity}); truncating.`);
      }
    }

    (this.pos.array as Float32Array).set(b.p.slice(0, count * 3));
    (this.nrm.array as Float32Array).set(b.n.slice(0, count * 3));
    (this.col.array as Float32Array).set(b.c.slice(0, count * 3));
    (this.anc.array as Float32Array).set(b.a.slice(0, count * 2));

    this.pos.needsUpdate = true;
    this.nrm.needsUpdate = true;
    this.col.needsUpdate = true;
    this.anc.needsUpdate = true;
    this.geo.setDrawRange(0, count);
  }

  set visible(v: boolean) { this.mesh.visible = v; }

  dispose(): void { this.geo.dispose(); }
}
