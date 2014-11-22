class Gift < ActiveRecord::Base
  belongs_to :list
  acts_as_list scope: :list
  
  def url
    "/#{list.try(:id)}"
  end
  
  def edit_link
    "/gifts/edit/#{id}"
  end
end