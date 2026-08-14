#!/usr/bin/env node
import { assessDataReadiness } from "../server/dataReadiness";
import { closeDatabaseForMaintenance } from "../server/db";

async function main() {
  const report = await assessDataReadiness();
  console.log("\nData readiness");
  console.log("----------------------------------------------------------------");
  console.log(`[${report.sqliteIntegrity === "ok" ? "PASS" : "FAIL"}] SQLite integrity: ${report.sqliteIntegrity}`);
  console.log(`[${report.foreignKeyViolations === 0 ? "PASS" : "FAIL"}] Foreign-key violations: ${report.foreignKeyViolations}`);
  for (const invariant of report.invariants) {
    console.log(
      `[${invariant.ok ? "PASS" : "FAIL"}] ${invariant.name}: ${invariant.count ?? invariant.detail ?? "ok"}`,
    );
  }
  console.log(`[${report.reconciliation.totalOrphans === 0 ? "PASS" : "FAIL"}] Reconciliation orphans: ${report.reconciliation.totalOrphans}`);
  console.log(`[${report.reconciliation.duplicateEmails.length === 0 ? "PASS" : "FAIL"}] Duplicate emails: ${report.reconciliation.duplicateEmails.length}`);
  const invalidNumericFields = report.numericIntegrity.fields.filter((field) => !field.ok);
  const invalidNumericConstraints = report.numericIntegrity.constraints.filter((constraint) => !constraint.ok);
  const emptyNumericValues = report.numericIntegrity.fields.reduce((sum, field) => sum + field.emptyValues, 0);
  console.log(
    `[${report.numericIntegrity.ok ? "PASS" : "FAIL"}] Numeric compatibility: ` +
      `${report.numericIntegrity.fields.length - invalidNumericFields.length}/${report.numericIntegrity.fields.length} fields, ` +
      `${report.numericIntegrity.constraints.length - invalidNumericConstraints.length}/${report.numericIntegrity.constraints.length} constraints, ` +
      `${emptyNumericValues} empty values accepted as zero`,
  );
  for (const field of invalidNumericFields) {
    console.log(
      `[FAIL] ${field.table}.${field.column}: ` +
        (field.available ? `${field.invalidValues} malformed or unsafe values` : "column unavailable"),
    );
  }
  for (const constraint of invalidNumericConstraints) {
    console.log(
      `[FAIL] ${constraint.name}: ` +
        (constraint.available ? `${constraint.violatingRows} violating rows` : "required columns unavailable"),
    );
  }
  console.log(`[${report.demoLikeRecords.users === 0 ? "PASS" : "FAIL"}] Demo/test user markers: ${report.demoLikeRecords.users}`);
  console.log(`[${report.demoLikeRecords.cases === 0 ? "PASS" : "FAIL"}] Demo/test case markers: ${report.demoLikeRecords.cases}`);
  if (!report.ok) throw new Error("Target database is not ready for production");
  console.log("\nTarget database readiness passed.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDatabaseForMaintenance());
