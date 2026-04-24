// ============================================================
//  SD POS — Backup Configuration
//  Edit DROPBOX_TOKEN to your Dropbox access token.
//  Backup runs automatically on the 1st of every month.
// ============================================================

module.exports = {
  DROPBOX_TOKEN:
    "sl.u.AGYShamusxSqxHnzXUWgF1_toWjFc-_-9pYgztD7Hi9Q2JYLLq-_mwGlRXdo6SV-8IfW9-cDKXn2lnYeXMANq9lGUZjjZRKAOM1Cb0hi1Hk9MpvmwThN52VQVcNTp8bwm1Z1A_8RRdgZAlHFlMmJ9mHkzuYfX1Y49blOA4ePWYaU_9dNv__Cww7Xm8Wc32Sg4n_txGw1oaa_3L5pzPDTdJ971sTA1_CnzvUxmsoMGvE2cRjkoxLL8hHpI6-A7JCVMP8OduzZug-Vffp_Ql4L60g6LfAulPTkMIy8sRb-G63xePJBzEzmddY55JBas76C7GDFBttRq16tR0-Mab0N0PircTIYyq873Zjum0JTTYwBxhXBJaXnuD8ZpLoDKm1td63PGiCDKfn_4SxUMI_ybXkKvyEItM4WoEBxIEZLvKKhvTJKQf0fovmlSToV2nNgD-NyjCqllHr5TKgB-KXoHG2x5jEkQVrGgAM2irHsPrbRIBCELDZkEJdf-CP1M46aoFvQxHUCFwvFsTEcsH3Dp0CZgRdecNbjoPGlFZL3HPjcr7tet7bYNKu1B8rhXGxVGrIx_uE2YBt_m6pL5X20TWk9svvghmc8GXjpTnHnCv1hUhubIYWmw3VdOJhkWg3LHCDoyTqogQYWEsunawdqbQP-2SHiwAD9rmY6BWRi2QNM8uzP9UDnXz_Z5MqpKdhxPTHysOV1UGym_-XNSl4e9SWYL5jxli7RzPxnnE5i_GpVY_tlE5a7IQn5gWuaaCyyOcPbetEVNnIuU76ludoUfOt0urAdzZ16dzNZnb6oePNnQj96WdS0L7rmUoGNonc9YOkiU-Mm-n5fYM1qX7zrLXT_5vT5JH_3nPnyZs4LtzncaBkZxJ7A4f0jk3JZ6KMGwzfk-ZA7VzxmnGKUI7KSmrye_cTgsBkyVNDV3yhbXzEoFP9G4fD2Dflc7D1dHUxYWVW9Ov1LmAm_BS7lBKarQEcnwDP9bdT2TqUyCnlPIDu_JiVlbY1JuaV6929NVo2fadStFkCval6ODyEoVXhjBzTyNkqnWUqxCflFWJ4JkwtdD2DVs-Wk1YjwQ86aIQEAw9STjOQWq9dtH1wUDkRoSmD6Ow1AKtMXwWfkpeHS6JNZLvft4brJCcYU-YQyC8N7RACSZIsdyeUJlB14dRefxB7hlUxb2p3z7LKDxjbWlRfltmZqkVPLqMhSR1xaMFwg3wxT8TpvZeJqFqdajur4UjCC1Vlz92uHpplfPfxQ9NOwQ5xIApI8v502bGQPC05SV79xzb3WUATT3I0KFkvRnZnVQQps6n5BWFhUGwWF5ovoJ_eJSdqb--GLcqSHilaWXXfG5PO9sZo4PaIaMKERFIj4RuMXTpZOkg-jLE82nQ8T8N98Ar8fZ2wYEg6VpJuh0zJS0K9Z2bssrEqqPl0uccOya6ALenx3AHRoscgWR_FUosg_ofr00zd9z66AqpHMvgc",
  DROPBOX_FOLDER: "/SD-POS-Backups",

  // Cron schedule: "0 2 1 * *" = 2:00 AM on the 1st of every month
  BACKUP_SCHEDULE: "0 2 1 * *",
};
