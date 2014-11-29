class Gift < ActiveRecord::Base
  belongs_to :list
  acts_as_list scope: :list
  
  def edit_link
    "/gifts/edit/#{id}"
  end
end