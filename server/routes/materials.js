"use strict";

const express = require("express");
const { requireAnyRole } = require("../security");
const { asyncHandler, logActivity } = require("../utils");
const {
  idSchema,
  materialUploadUrlSchema,
  materialChunkSchema,
  materialCreateSchema,
  materialUpdateSchema,
  materialListSchema
} = require("../validation");
const {
  createUploadForm,
  hasUsableBucket,
  resolveBucketName,
  resolveFileType,
  storagePathFor
} = require("../storage");
const { saveChunk, readBlob } = require("../material-blobs");
const { getDocById } = require("../fdb");
const config = require("../config");
const {
  assertManageableScope,
  visibleToUser,
  allowedClassIds,
  listMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  trackMaterialView
} = require("../materials");

const router = express.Router();
const manage = requireAnyRole("admin", "teacher");

// Available to every authenticated role. Students receive only their class.
router.get("/", asyncHandler(async (req, res) => {
  const filters = materialListSchema.parse(req.query);
  return res.json(await listMaterials(req.user, filters));
}));

router.post("/upload-url", manage, asyncHandler(async (req, res) => {
  const input = materialUploadUrlSchema.parse(req.body);
  await assertManageableScope(req.user, input.classIds, input.subjectId);
  const fileType = resolveFileType(input.fileName, input.contentType);
  const storagePath = storagePathFor(input.fileName);
  if (!await hasUsableBucket()) {
    if (input.sizeBytes > config.materialFirestoreMaxBytes) {
      throw Object.assign(
        new Error("This project has no Cloud Storage bucket, so files larger than 10 MB cannot be uploaded."),
        { status: 413 }
      );
    }
    return res.json({
      mode: "firestore",
      uploadUrl: "/api/materials/upload-chunks",
      uploadFields: {},
      storagePath,
      fileType,
      bucket: "Firestore",
      chunkSize: config.materialChunkBase64Bytes,
      subjectId: input.subjectId || null,
      classIds: input.classIds
    });
  }

  const origin = `${req.protocol}://${req.get("host")}`;
  const form = await createUploadForm({
    storagePath,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    successActionRedirect: `${origin}/upload-complete.html?path=${encodeURIComponent(storagePath)}`
  });
  return res.json({
    mode: "storage",
    uploadUrl: form.url,
    uploadFields: form.fields,
    storagePath,
    fileType,
    bucket: await resolveBucketName()
  });
}));

router.post("/upload-chunks", manage, asyncHandler(async (req, res) => {
  const input = materialChunkSchema.parse(req.body);
  await assertManageableScope(req.user, input.classIds, input.subjectId);
  await saveChunk({ ...input, uploadedBy: req.user.id });
  return res.json({ ok: true, complete: input.index === input.total - 1 });
}));

router.post("/", manage, asyncHandler(async (req, res) => {
  const input = materialCreateSchema.parse(req.body);
  const id = await createMaterial(req.user, input);
  await logActivity(req.user, "material_uploaded", { event: "materials" });
  return res.status(201).json({ material: { id } });
}));

router.patch("/:id", manage, asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = materialUpdateSchema.parse(req.body);
  await updateMaterial(req.user, id, input);
  await logActivity(req.user, "material_updated", { event: "materials" });
  return res.json({ ok: true });
}));

router.delete("/:id", manage, asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await deleteMaterial(req.user, id);
  await logActivity(req.user, "material_removed", { event: "materials" });
  return res.json({ ok: true, deleted: true });
}));

router.get("/:id/file", asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const row = await getDocById("materials", id);
  if (!row || row.deleted_at || row.kind !== "file") {
    return res.status(404).json({ error: "Material not found." });
  }
  const allowed = await allowedClassIds(req.user);
  if (!visibleToUser(row, req.user, allowed)) {
    return res.status(403).json({ error: "This material is not assigned to your class." });
  }
  const stored = await readBlob(row.storage_path);
  if (!stored) {
    return res.status(404).json({ error: "This file is no longer available." });
  }
  const fileName = String(stored.blob.file_name || "material");
  const safeName = fileName.replace(/[\r\n"]/g, "_");
  return res
    .type(stored.blob.content_type || "application/octet-stream")
    .set("Content-Disposition", `inline; filename="${safeName}"`)
    .send(stored.buffer);
}));

router.post("/:id/view", asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await trackMaterialView(req.user, id);
  return res.json({ ok: true });
}));

module.exports = router;
