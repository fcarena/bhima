angular.module('bhima.controllers')
  .controller('ReverseVoucherModalController', ReverseModalCtrl);

ReverseModalCtrl.$inject = [
  '$uibModalInstance', 'data', 'VoucherService', 'NotifyService', '$translate',
  'CurrencyService', 'bhConstants', '$state',
];

function ReverseModalCtrl(
  Instance, data, Vouchers, Notify, $translate, CurrencyService,
  bhConstants, $state
) {
  const vm = this;
  vm.Constants = bhConstants;

  vm.cancel = () => Instance.close(false);
  vm.submit = submit;

  // this will be sent back to the server as the new record
  vm.record = { date : new Date() };

  function startup() {
    Vouchers.read(data.uuid)
      .then(voucher => {
        vm.voucher = voucher;
        vm.record.uuid = voucher.uuid;
      });
  }

  function submit(form) {
    if (form.$invalid) { return 0; }

    return Vouchers.reverse(vm.record);
  }

  startup();
}
