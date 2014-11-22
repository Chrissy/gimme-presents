$(function() {
  $(".toggle-edit-controls").click(function(e){
    $('.edit-gift-container').removeClass("active")
    var $this = $(this)
    var editContainer = $this.siblings('.edit-gift-container')
    e.stopPropagation()
    var addBlurHandler = function(){
      $(document).one("click", function(e){
        if (!$(e.target).closest(editContainer).length) {
          editContainer.removeClass('active')
        } else {
          addBlurHandler() 
        }
      })
    }
    addBlurHandler()
    editContainer.toggleClass('active')
    e.preventDefault()
  })
})