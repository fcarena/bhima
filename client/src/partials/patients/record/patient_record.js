angular.module('bhima.controllers')
.controller('PatientRecordController', PatientRecordController);

PatientRecordController.$inject = ['$stateParams', 'PatientService', 'NotifyService', 'moment', 'Upload', '$timeout'];

function PatientRecordController($stateParams, Patients, Notify, moment, Upload, $timeout) {
  var vm = this;
  var patientID = $stateParams.patientID;

  vm.loading = true;
  vm.uploadFiles = uploadFiles;
  vm.uploadButtonText = 'PATIENT_RECORDS.UPLOAD_PICTURE';

  function uploadFiles(file, invalidFiles) {
    if(invalidFiles.length){
      Notify.danger('FORM.WARNNINGS.BAD_FILE_TYPE');
      return;
    }

    if (file) {
      var imageCheck = file.type.search('image/');
      if(imageCheck !== -1){
        file.upload = Upload.upload({
          url: '/patients/' + patientID + '/pictures',
          data: {pictures: file}
        });

        file.upload.then(function (response) {
          Notify.success('FORM.INFOS.PATIENT_SUCC_TRANSFERRED');
          $timeout(function () {
            vm.patient.avatar = response.data.link;
          });
        })
        .catch(function (error) {
          Notify.handleError(error);
        });
      } else {
        Notify.danger('FORM.INFOS.UPLOAD_PICTURE_FAILED');
      }
    }
  }

  /** @fixme if no uuid is provided this will download all the patients through the base url '/' */
  Patients.read(patientID)
    .then(function (result) {
      vm.patient = result;
      vm.loading = false;

      if(vm.patient.avatar){
        vm.uploadButtonText = 'PATIENT_RECORDS.UPDATE_PICTURE';
      }

      /** @todo move to service or mysql query */
      vm.patient.name = [vm.patient.first_name, vm.patient.middle_name, vm.patient.last_name].join(' ');
      vm.patient.age = moment().diff(vm.patient.dob, 'years');
    })
    .catch(function (error) {
      vm.loading = false;
      Notify.handleError(error);
    });
}