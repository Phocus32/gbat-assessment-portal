"use strict";

const express = require("express");
const { requireAnyRole } = require("../security");
const { asyncHandler, logActivity } = require("../utils");
const {
  idSchema,
  materialUploadUrlSchema,
  materialCreateSchema,
  materialUpdateSchema,
  materialListSchema
} = require("../validation");
const {
  createUploadForm,
  resolveBucketName,
  resolveFileType,
  storagePathFor
} = require("../storage");
const {
  assertManageableScope,
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
  const origin = `${req.protocol}://${req.get("host")}`;
  const form = await createUploadForm({
    storagePath,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    successActionRedirect: `${origin}/upload-complete.html?path=${encodeURIComponent(storagePath)}`
  });
  return res.json({
    uploadUrl: form.url,
    uploadFields: form.fields,
    storagePath,
    fileType,
    bucket: await resolveBucketName()
  });
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

router.post("/:id/view", asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await trackMaterialView(req.user, id);
  return res.json({ ok: true });
}));

module.exports = router;
